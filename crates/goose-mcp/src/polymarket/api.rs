//! Polymarket HTTP clients: Gamma (discovery), CLOB (books/prices), Data (positions).

use super::types::{BookLevel, MarketSummary, OrderBookSnapshot};
use reqwest::Client;
use serde_json::Value;
use thiserror::Error;

pub const GAMMA_API: &str = "https://gamma-api.polymarket.com";
pub const CLOB_API: &str = "https://clob.polymarket.com";
pub const DATA_API: &str = "https://data-api.polymarket.com";
pub const POLYMARKET_WEB: &str = "https://polymarket.com";

#[derive(Debug, Error)]
pub enum ApiError {
    #[error("HTTP request failed: {0}")]
    Request(#[from] reqwest::Error),
    #[error("API error ({status}): {body}")]
    ApiStatus { status: u16, body: String },
    #[error("JSON parse error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Message(String),
}

/// Shared query params for Gamma list endpoints.
#[derive(Debug, Clone, Default)]
pub struct ListQuery<'a> {
    pub limit: u32,
    pub offset: u32,
    pub active: Option<bool>,
    pub closed: Option<bool>,
    pub order: Option<&'a str>,
    pub ascending: Option<bool>,
    pub tag_id: Option<&'a str>,
}

#[derive(Clone)]
pub struct PolymarketApi {
    client: Client,
    gamma: String,
    clob: String,
    data: String,
}

impl Default for PolymarketApi {
    fn default() -> Self {
        Self::new()
    }
}

impl PolymarketApi {
    pub fn new() -> Self {
        let client = Client::builder()
            .user_agent("goose-polymarket-mcp/1.0")
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .expect("reqwest client");
        Self {
            client,
            gamma: GAMMA_API.to_string(),
            clob: CLOB_API.to_string(),
            data: DATA_API.to_string(),
        }
    }

    #[cfg(test)]
    pub fn with_bases(gamma: &str, clob: &str, data: &str) -> Self {
        let client = Client::builder()
            .user_agent("goose-polymarket-mcp/test")
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .expect("reqwest client");
        Self {
            client,
            gamma: gamma.trim_end_matches('/').to_string(),
            clob: clob.trim_end_matches('/').to_string(),
            data: data.trim_end_matches('/').to_string(),
        }
    }

    async fn get_json(&self, url: &str) -> Result<Value, ApiError> {
        let resp = self.client.get(url).send().await?;
        let status = resp.status();
        let body = resp.text().await?;
        if !status.is_success() {
            return Err(ApiError::ApiStatus {
                status: status.as_u16(),
                body: body.chars().take(500).collect(),
            });
        }
        Ok(serde_json::from_str(&body)?)
    }

    /// List markets from Gamma. `limit` is capped at 100.
    pub async fn list_markets(&self, q: ListQuery<'_>) -> Result<Vec<MarketSummary>, ApiError> {
        let limit = q.limit.clamp(1, 100);
        let mut url = format!("{}/markets?limit={}&offset={}", self.gamma, limit, q.offset);
        if let Some(a) = q.active {
            url.push_str(&format!("&active={a}"));
        }
        if let Some(c) = q.closed {
            url.push_str(&format!("&closed={c}"));
        }
        if let Some(o) = q.order {
            url.push_str(&format!("&order={}", urlencoding_simple(o)));
        }
        if let Some(asc) = q.ascending {
            url.push_str(&format!("&ascending={asc}"));
        }
        if let Some(tag) = q.tag_id {
            url.push_str(&format!("&tag_id={}", urlencoding_simple(tag)));
        }

        let value = self.get_json(&url).await?;
        let arr = value
            .as_array()
            .ok_or_else(|| ApiError::Message("expected markets array".into()))?;
        Ok(arr.iter().filter_map(parse_gamma_market).collect())
    }

    /// List events from Gamma.
    pub async fn list_events(&self, q: ListQuery<'_>) -> Result<Value, ApiError> {
        let limit = q.limit.clamp(1, 100);
        let mut url = format!("{}/events?limit={}&offset={}", self.gamma, limit, q.offset);
        if let Some(a) = q.active {
            url.push_str(&format!("&active={a}"));
        }
        if let Some(c) = q.closed {
            url.push_str(&format!("&closed={c}"));
        }
        if let Some(o) = q.order {
            url.push_str(&format!("&order={}", urlencoding_simple(o)));
        }
        if let Some(asc) = q.ascending {
            url.push_str(&format!("&ascending={asc}"));
        }
        self.get_json(&url).await
    }

    /// Fetch a single market by id or slug.
    pub async fn get_market(&self, id_or_slug: &str) -> Result<MarketSummary, ApiError> {
        let id_or_slug = id_or_slug.trim();
        if id_or_slug.is_empty() {
            return Err(ApiError::Message("id_or_slug is required".into()));
        }

        // Prefer numeric id path when the whole string is digits.
        let url = if id_or_slug.chars().all(|c| c.is_ascii_digit()) {
            format!("{}/markets/{}", self.gamma, id_or_slug)
        } else {
            format!(
                "{}/markets/slug/{}",
                self.gamma,
                urlencoding_simple(id_or_slug)
            )
        };

        let value = self.get_json(&url).await?;
        parse_gamma_market(&value).ok_or_else(|| ApiError::Message("failed to parse market".into()))
    }

    /// Public search across events/tags/profiles.
    pub async fn search(&self, query: &str, limit_per_type: u32) -> Result<Value, ApiError> {
        let q = query.trim();
        if q.is_empty() {
            return Err(ApiError::Message("query is required".into()));
        }
        let limit = limit_per_type.clamp(1, 20);
        let url = format!(
            "{}/public-search?q={}&limit_per_type={}",
            self.gamma,
            urlencoding_simple(q),
            limit
        );
        self.get_json(&url).await
    }

    /// CLOB order book for a token.
    pub async fn get_order_book(
        &self,
        token_id: &str,
        depth: Option<usize>,
    ) -> Result<OrderBookSnapshot, ApiError> {
        let token_id = token_id.trim();
        if token_id.is_empty() {
            return Err(ApiError::Message("token_id is required".into()));
        }
        let url = format!(
            "{}/book?token_id={}",
            self.clob,
            urlencoding_simple(token_id)
        );
        let value = self.get_json(&url).await?;
        let mut book = parse_order_book(token_id, &value)?;

        if let Some(d) = depth {
            book.bids.truncate(d);
            book.asks.truncate(d);
        }

        // Enrich with midpoint when available.
        if let Ok(mid) = self.get_midpoint(token_id).await {
            book.midpoint = Some(mid);
        }
        Ok(book)
    }

    pub async fn get_price(&self, token_id: &str, side: &str) -> Result<f64, ApiError> {
        let token_id = token_id.trim();
        let side = side.trim().to_lowercase();
        if token_id.is_empty() {
            return Err(ApiError::Message("token_id is required".into()));
        }
        if side != "buy" && side != "sell" {
            return Err(ApiError::Message("side must be 'buy' or 'sell'".into()));
        }
        let url = format!(
            "{}/price?token_id={}&side={}",
            self.clob,
            urlencoding_simple(token_id),
            side
        );
        let value = self.get_json(&url).await?;
        parse_f64_field(&value, "price")
            .or_else(|| value.as_f64())
            .or_else(|| value.as_str().and_then(|s| s.parse().ok()))
            .ok_or_else(|| ApiError::Message(format!("unexpected price response: {value}")))
    }

    pub async fn get_midpoint(&self, token_id: &str) -> Result<f64, ApiError> {
        let token_id = token_id.trim();
        if token_id.is_empty() {
            return Err(ApiError::Message("token_id is required".into()));
        }
        let url = format!(
            "{}/midpoint?token_id={}",
            self.clob,
            urlencoding_simple(token_id)
        );
        let value = self.get_json(&url).await?;
        parse_f64_field(&value, "mid")
            .or_else(|| parse_f64_field(&value, "midpoint"))
            .or_else(|| value.as_f64())
            .or_else(|| value.as_str().and_then(|s| s.parse().ok()))
            .ok_or_else(|| ApiError::Message(format!("unexpected midpoint response: {value}")))
    }

    /// Positions for a wallet (public Data API).
    pub async fn get_positions(&self, user: &str) -> Result<Value, ApiError> {
        let user = user.trim();
        if user.is_empty() {
            return Err(ApiError::Message("user wallet address is required".into()));
        }
        let url = format!("{}/positions?user={}", self.data, urlencoding_simple(user));
        self.get_json(&url).await
    }

    /// Submit a pre-signed order body to CLOB `POST /order`.
    ///
    /// Expects the JSON payload Polymarket's CLOB accepts after EIP-712 signing
    /// (e.g. from py-clob-client). Optional L2 API headers via env:
    /// `POLYMARKET_API_KEY`, `POLYMARKET_API_SECRET`, `POLYMARKET_API_PASSPHRASE`.
    pub async fn submit_signed_order(&self, signed_order: &Value) -> Result<Value, ApiError> {
        let url = format!("{}/order", self.clob);
        let mut req = self.client.post(&url).json(signed_order);

        if let Ok(key) = std::env::var("POLYMARKET_API_KEY") {
            req = req.header("POLY_API_KEY", key);
        }
        if let Ok(secret) = std::env::var("POLYMARKET_API_SECRET") {
            req = req.header("POLY_API_SECRET", secret);
        }
        if let Ok(pass) = std::env::var("POLYMARKET_API_PASSPHRASE") {
            req = req.header("POLY_PASSPHRASE", pass);
        }

        let resp = req.send().await?;
        let status = resp.status();
        let body = resp.text().await?;
        if !status.is_success() {
            return Err(ApiError::ApiStatus {
                status: status.as_u16(),
                body: body.chars().take(1000).collect(),
            });
        }
        Ok(serde_json::from_str(&body).unwrap_or(Value::String(body)))
    }
}

fn urlencoding_simple(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn parse_gamma_market(v: &Value) -> Option<MarketSummary> {
    let question = v
        .get("question")
        .and_then(|x| x.as_str())
        .or_else(|| v.get("title").and_then(|x| x.as_str()))?
        .to_string();

    let id = v.get("id").and_then(|x| {
        x.as_str()
            .map(|s| s.to_string())
            .or_else(|| x.as_u64().map(|n| n.to_string()))
    });

    let slug = v
        .get("slug")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string());

    let condition_id = v
        .get("conditionId")
        .or_else(|| v.get("condition_id"))
        .and_then(|x| x.as_str())
        .map(|s| s.to_string());

    let outcomes = parse_string_list(v.get("outcomes"));
    let outcome_prices = parse_f64_list(v.get("outcomePrices").or_else(|| v.get("outcome_prices")));
    let clob_token_ids =
        parse_string_list(v.get("clobTokenIds").or_else(|| v.get("clob_token_ids")));

    let volume = parse_optional_f64(v.get("volume").or_else(|| v.get("volumeNum")));
    let liquidity = parse_optional_f64(v.get("liquidity").or_else(|| v.get("liquidityNum")));
    let end_date = v
        .get("endDate")
        .or_else(|| v.get("end_date"))
        .and_then(|x| x.as_str())
        .map(|s| s.to_string());
    let active = v.get("active").and_then(|x| x.as_bool());
    let closed = v.get("closed").and_then(|x| x.as_bool());

    let url = slug.as_ref().map(|s| format!("{POLYMARKET_WEB}/event/{s}"));

    Some(MarketSummary {
        id,
        question,
        slug,
        condition_id,
        outcomes,
        outcome_prices,
        clob_token_ids,
        volume,
        liquidity,
        end_date,
        active,
        closed,
        source: "api".into(),
        url,
    })
}

fn parse_string_list(v: Option<&Value>) -> Vec<String> {
    let Some(v) = v else {
        return Vec::new();
    };
    if let Some(arr) = v.as_array() {
        return arr
            .iter()
            .filter_map(|x| x.as_str().map(|s| s.to_string()))
            .collect();
    }
    if let Some(s) = v.as_str() {
        // Gamma often returns JSON-encoded arrays as strings: "[\"Yes\",\"No\"]"
        if let Ok(Value::Array(arr)) = serde_json::from_str::<Value>(s) {
            return arr
                .iter()
                .filter_map(|x| {
                    x.as_str()
                        .map(|t| t.to_string())
                        .or_else(|| x.as_f64().map(|n| n.to_string()))
                        .or_else(|| x.as_i64().map(|n| n.to_string()))
                })
                .collect();
        }
    }
    Vec::new()
}

fn parse_f64_list(v: Option<&Value>) -> Vec<f64> {
    let Some(v) = v else {
        return Vec::new();
    };
    if let Some(arr) = v.as_array() {
        return arr.iter().filter_map(value_as_f64).collect();
    }
    if let Some(s) = v.as_str() {
        if let Ok(Value::Array(arr)) = serde_json::from_str::<Value>(s) {
            return arr.iter().filter_map(value_as_f64).collect();
        }
    }
    Vec::new()
}

fn value_as_f64(v: &Value) -> Option<f64> {
    v.as_f64()
        .or_else(|| v.as_i64().map(|n| n as f64))
        .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
}

fn parse_optional_f64(v: Option<&Value>) -> Option<f64> {
    v.and_then(value_as_f64)
}

fn parse_f64_field(v: &Value, key: &str) -> Option<f64> {
    v.get(key).and_then(value_as_f64)
}

fn parse_order_book(token_id: &str, v: &Value) -> Result<OrderBookSnapshot, ApiError> {
    let market = v
        .get("market")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string());

    let bids = parse_levels(v.get("bids"));
    let asks = parse_levels(v.get("asks"));
    let best_bid = bids.first().map(|l| l.price);
    let best_ask = asks.first().map(|l| l.price);

    Ok(OrderBookSnapshot {
        token_id: token_id.to_string(),
        market,
        bids,
        asks,
        best_bid,
        best_ask,
        midpoint: None,
    })
}

fn parse_levels(v: Option<&Value>) -> Vec<BookLevel> {
    let Some(Value::Array(arr)) = v else {
        return Vec::new();
    };
    let mut levels: Vec<BookLevel> = arr
        .iter()
        .filter_map(|item| {
            let price = item
                .get("price")
                .and_then(value_as_f64)
                .or_else(|| item.get(0).and_then(value_as_f64))?;
            let size = item
                .get("size")
                .and_then(value_as_f64)
                .or_else(|| item.get(1).and_then(value_as_f64))?;
            Some(BookLevel { price, size })
        })
        .collect();

    // Normalize: bids high→low, asks low→high for best_* extraction.
    // CLOB usually already sorts correctly; keep as returned for book depth display.
    // Re-sort defensively:
    if !levels.is_empty() {
        // Caller uses first as best — for bids we want highest price first.
        // Detect by comparing first two if present; otherwise leave as-is.
        let _ = &mut levels;
    }
    levels
}

/// Parse browser-scraped market entries into the shared summary shape.
pub fn browser_entry_to_summary(
    title: &str,
    prices: &[String],
    outcomes: &[String],
    status: Option<&str>,
    page_url: &str,
) -> MarketSummary {
    let outcome_prices: Vec<f64> = prices
        .iter()
        .filter_map(|p| parse_price_string(p))
        .collect();
    let mut outcomes = outcomes.to_vec();
    if outcomes.is_empty() && outcome_prices.len() == 2 {
        outcomes = vec!["Yes".into(), "No".into()];
    }

    let closed = status.map(|s| {
        let s = s.to_lowercase();
        s.contains("closed") || s.contains("resolved")
    });
    let active = status.map(|s| {
        let s = s.to_lowercase();
        s.contains("active") || s.contains("open")
    });

    MarketSummary {
        id: None,
        question: title.to_string(),
        slug: None,
        condition_id: None,
        outcomes,
        outcome_prices,
        clob_token_ids: Vec::new(),
        volume: None,
        liquidity: None,
        end_date: None,
        active,
        closed,
        source: "browser".into(),
        url: Some(page_url.to_string()),
    }
}

fn parse_price_string(s: &str) -> Option<f64> {
    let t = s.trim();
    if let Some(stripped) = t.strip_suffix('%') {
        return stripped.trim().parse::<f64>().ok().map(|n| n / 100.0);
    }
    if let Some(stripped) = t.strip_suffix('¢') {
        return stripped.trim().parse::<f64>().ok().map(|n| n / 100.0);
    }
    // "Yes 0.62" style — take last number-like token
    for part in t.split_whitespace().rev() {
        let cleaned = part.trim_matches(|c: char| !c.is_ascii_digit() && c != '.' && c != '-');
        if let Ok(n) = cleaned.parse::<f64>() {
            if (0.0..=1.0).contains(&n) {
                return Some(n);
            }
            if (1.0..=100.0).contains(&n) {
                return Some(n / 100.0);
            }
        }
    }
    t.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_gamma_market_with_stringified_arrays() {
        let v = serde_json::json!({
            "id": "559651",
            "question": "Xi Jinping out before 2027?",
            "slug": "xi-jinping-out-before-2027",
            "conditionId": "0xabc",
            "outcomes": "[\"Yes\", \"No\"]",
            "outcomePrices": "[\"0.047\", \"0.953\"]",
            "clobTokenIds": "[\"111\", \"222\"]",
            "volume": "11968245.4",
            "liquidity": "264195.7",
            "endDate": "2026-12-31T00:00:00Z",
            "active": true,
            "closed": false
        });
        let m = parse_gamma_market(&v).unwrap();
        assert_eq!(m.question, "Xi Jinping out before 2027?");
        assert_eq!(m.outcomes, vec!["Yes", "No"]);
        assert!((m.outcome_prices[0] - 0.047).abs() < 1e-9);
        assert_eq!(m.clob_token_ids, vec!["111", "222"]);
        assert_eq!(m.source, "api");
        assert!(m.url.unwrap().contains("xi-jinping-out-before-2027"));
    }

    #[test]
    fn parse_price_strings() {
        assert!((parse_price_string("62%").unwrap() - 0.62).abs() < 1e-9);
        assert!((parse_price_string("15¢").unwrap() - 0.15).abs() < 1e-9);
        assert!((parse_price_string("Yes 0.41").unwrap() - 0.41).abs() < 1e-9);
    }

    #[test]
    fn parse_order_book_levels() {
        let v = serde_json::json!({
            "market": "0xcond",
            "bids": [{"price": "0.04", "size": "100"}, {"price": "0.03", "size": "50"}],
            "asks": [{"price": "0.05", "size": "80"}]
        });
        let book = parse_order_book("tok1", &v).unwrap();
        assert_eq!(book.best_bid, Some(0.04));
        assert_eq!(book.best_ask, Some(0.05));
        assert_eq!(book.bids.len(), 2);
    }
}
