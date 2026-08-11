//! Order intent construction and risk checks (paper-first).

use super::types::{IntentOrderType, OrderIntent, OrderSide, RiskCheckResult, RiskLimits};

#[derive(Debug, Clone)]
pub struct BuildOrderRequest {
    pub token_id: String,
    pub side: OrderSide,
    pub price: f64,
    pub size: f64,
    pub order_type: IntentOrderType,
    pub market_id: Option<String>,
    pub market_question: Option<String>,
    pub rationale: Option<String>,
    pub fair_prob: Option<f64>,
    pub dry_run: bool,
    pub limits: RiskLimits,
}

/// Build an order intent after applying risk checks.
///
/// Returns `Ok` only when all hard risk checks pass. Soft guidance (edge vs
/// fair_prob) is recorded in `risk_checks` and fails when `min_edge` is set
/// and `fair_prob` is provided.
pub fn build_order_intent(req: BuildOrderRequest) -> Result<OrderIntent, String> {
    let notional = req.price * req.size;
    let edge = req.fair_prob.map(|fp| match req.side {
        OrderSide::Buy => fp - req.price,
        OrderSide::Sell => req.price - fp,
    });

    let mut checks = Vec::new();

    // Hard checks
    let price_ok = (0.0..=1.0).contains(&req.price);
    checks.push(RiskCheckResult {
        name: "price_in_unit_interval".into(),
        passed: price_ok,
        detail: format!("price={}", req.price),
    });

    let size_ok = req.size >= req.limits.min_size;
    checks.push(RiskCheckResult {
        name: "min_size".into(),
        passed: size_ok,
        detail: format!("size={} min={}", req.size, req.limits.min_size),
    });

    let notional_ok = notional > 0.0 && notional <= req.limits.max_notional_usdc;
    checks.push(RiskCheckResult {
        name: "max_notional".into(),
        passed: notional_ok,
        detail: format!(
            "notional≈{notional:.4} max={}",
            req.limits.max_notional_usdc
        ),
    });

    let side_price_ok = match req.side {
        OrderSide::Buy => req.price <= req.limits.max_buy_price,
        OrderSide::Sell => req.price >= req.limits.min_sell_price,
    };
    checks.push(RiskCheckResult {
        name: "side_price_bound".into(),
        passed: side_price_ok,
        detail: match req.side {
            OrderSide::Buy => format!(
                "buy price={} max_buy_price={}",
                req.price, req.limits.max_buy_price
            ),
            OrderSide::Sell => format!(
                "sell price={} min_sell_price={}",
                req.price, req.limits.min_sell_price
            ),
        },
    });

    let token_ok = !req.token_id.trim().is_empty();
    checks.push(RiskCheckResult {
        name: "token_id_present".into(),
        passed: token_ok,
        detail: if token_ok {
            "token_id set".into()
        } else {
            "token_id empty".into()
        },
    });

    if let Some(e) = edge {
        let edge_ok = e >= req.limits.min_edge;
        checks.push(RiskCheckResult {
            name: "min_edge".into(),
            passed: edge_ok,
            detail: format!("edge={e:.4} min_edge={}", req.limits.min_edge),
        });
    } else {
        checks.push(RiskCheckResult {
            name: "min_edge".into(),
            passed: true,
            detail: "fair_prob not provided; edge check skipped".into(),
        });
    }

    if !req.dry_run {
        let live_enabled = std::env::var("POLYMARKET_ENABLE_LIVE_ORDERS")
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false);
        checks.push(RiskCheckResult {
            name: "live_orders_enabled".into(),
            passed: live_enabled,
            detail: if live_enabled {
                "POLYMARKET_ENABLE_LIVE_ORDERS is set".into()
            } else {
                "Set POLYMARKET_ENABLE_LIVE_ORDERS=1 to allow live orders".into()
            },
        });
    }

    let hard_failed: Vec<&RiskCheckResult> = checks.iter().filter(|c| !c.passed).collect();
    if !hard_failed.is_empty() {
        let msg = hard_failed
            .iter()
            .map(|c| format!("{}: {}", c.name, c.detail))
            .collect::<Vec<_>>()
            .join("; ");
        return Err(format!("risk checks failed: {msg}"));
    }

    Ok(OrderIntent {
        token_id: req.token_id,
        side: req.side,
        price: req.price,
        size: req.size,
        order_type: req.order_type,
        notional_usdc: notional,
        market_id: req.market_id,
        market_question: req.market_question,
        rationale: req.rationale,
        edge,
        fair_prob: req.fair_prob,
        dry_run: req.dry_run,
        risk_checks: checks,
    })
}

/// Suggest a simple limit price from book midpoint / fair prob.
pub fn suggest_limit_price(
    side: &OrderSide,
    fair_prob: Option<f64>,
    midpoint: Option<f64>,
    best_bid: Option<f64>,
    best_ask: Option<f64>,
) -> Option<f64> {
    match side {
        OrderSide::Buy => {
            // Prefer resting at or inside the bid, capped by fair_prob if known.
            let base = best_bid.or(midpoint).or(fair_prob)?;
            let capped = fair_prob.map(|fp| base.min(fp)).unwrap_or(base);
            Some(capped.clamp(0.01, 0.99))
        }
        OrderSide::Sell => {
            let base = best_ask.or(midpoint).or(fair_prob)?;
            let floored = fair_prob.map(|fp| base.max(fp)).unwrap_or(base);
            Some(floored.clamp(0.01, 0.99))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_buy(dry_run: bool) -> BuildOrderRequest {
        BuildOrderRequest {
            token_id: "123".into(),
            side: OrderSide::Buy,
            price: 0.40,
            size: 10.0,
            order_type: IntentOrderType::Gtc,
            market_id: Some("m1".into()),
            market_question: Some("Will X happen?".into()),
            rationale: Some("edge vs fair".into()),
            fair_prob: Some(0.55),
            dry_run,
            limits: RiskLimits::default(),
        }
    }

    #[test]
    fn dry_run_buy_with_edge_passes() {
        let intent = build_order_intent(sample_buy(true)).unwrap();
        assert!(intent.dry_run);
        assert!((intent.notional_usdc - 4.0).abs() < 1e-9);
        assert!(intent.edge.unwrap() > 0.1);
    }

    #[test]
    fn fails_when_notional_too_large() {
        let mut req = sample_buy(true);
        req.size = 1000.0;
        req.price = 0.5;
        let err = build_order_intent(req).unwrap_err();
        assert!(err.contains("max_notional"));
    }

    #[test]
    fn fails_when_edge_too_small() {
        let mut req = sample_buy(true);
        req.fair_prob = Some(0.41);
        req.price = 0.40;
        let err = build_order_intent(req).unwrap_err();
        assert!(err.contains("min_edge"));
    }

    #[test]
    fn live_without_env_fails() {
        std::env::remove_var("POLYMARKET_ENABLE_LIVE_ORDERS");
        let err = build_order_intent(sample_buy(false)).unwrap_err();
        assert!(err.contains("live_orders_enabled"));
    }

    #[test]
    fn suggest_buy_uses_bid() {
        let p = suggest_limit_price(
            &OrderSide::Buy,
            Some(0.6),
            Some(0.5),
            Some(0.48),
            Some(0.52),
        )
        .unwrap();
        assert!((p - 0.48).abs() < 1e-9);
    }
}
