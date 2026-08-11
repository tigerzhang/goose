//! Shared types for Polymarket MCP responses and order intents.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Normalized market summary used by both API and browser paths.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
pub struct MarketSummary {
    pub id: Option<String>,
    pub question: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slug: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub condition_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub outcomes: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub outcome_prices: Vec<f64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub clob_token_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub volume: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub liquidity: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub closed: Option<bool>,
    /// Provenance: "api" or "browser"
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

/// Order book snapshot (best levels + optional depth).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
pub struct OrderBookSnapshot {
    pub token_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub market: Option<String>,
    #[serde(default)]
    pub bids: Vec<BookLevel>,
    #[serde(default)]
    pub asks: Vec<BookLevel>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub best_bid: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub best_ask: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub midpoint: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
pub struct BookLevel {
    pub price: f64,
    pub size: f64,
}

/// Side of an order intent.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum OrderSide {
    Buy,
    Sell,
}

impl OrderSide {
    pub fn as_str(&self) -> &'static str {
        match self {
            OrderSide::Buy => "BUY",
            OrderSide::Sell => "SELL",
        }
    }
}

/// Order type for CLOB intents.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq, Default)]
#[serde(rename_all = "UPPERCASE")]
pub enum IntentOrderType {
    #[default]
    Gtc,
    Gtd,
    Fok,
    Fak,
}

impl IntentOrderType {
    pub fn as_str(&self) -> &'static str {
        match self {
            IntentOrderType::Gtc => "GTC",
            IntentOrderType::Gtd => "GTD",
            IntentOrderType::Fok => "FOK",
            IntentOrderType::Fak => "FAK",
        }
    }
}

/// Structured order intent produced by strategy (paper or live).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
pub struct OrderIntent {
    pub token_id: String,
    pub side: OrderSide,
    /// Limit price in 0–1 probability space (e.g. 0.42).
    pub price: f64,
    /// Share size (outcome tokens).
    pub size: f64,
    pub order_type: IntentOrderType,
    /// Estimated notional in USDC ≈ price * size for buys of YES/NO shares.
    pub notional_usdc: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub market_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub market_question: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rationale: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub edge: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fair_prob: Option<f64>,
    /// Always true unless live submission was requested and accepted.
    pub dry_run: bool,
    pub risk_checks: Vec<RiskCheckResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq)]
pub struct RiskCheckResult {
    pub name: String,
    pub passed: bool,
    pub detail: String,
}

/// Bundle of market data for LLM analysis.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct AnalysisContext {
    pub market: MarketSummary,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub yes_book: Option<OrderBookSnapshot>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub no_book: Option<OrderBookSnapshot>,
    /// Short guidance for the model on how to score this market.
    pub analysis_prompt_hints: Vec<String>,
}

/// Risk limits applied when building order intents.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct RiskLimits {
    /// Maximum notional (USDC) per order. Default 25.
    #[serde(default = "default_max_notional")]
    pub max_notional_usdc: f64,
    /// Minimum edge (fair_prob - price for buys) required. Default 0.05.
    #[serde(default = "default_min_edge")]
    pub min_edge: f64,
    /// Maximum price for buys (avoid buying near 1.0). Default 0.95.
    #[serde(default = "default_max_buy_price")]
    pub max_buy_price: f64,
    /// Minimum price for sells. Default 0.05.
    #[serde(default = "default_min_sell_price")]
    pub min_sell_price: f64,
    /// Minimum order size (shares). Default 1.0.
    #[serde(default = "default_min_size")]
    pub min_size: f64,
}

fn default_max_notional() -> f64 {
    25.0
}
fn default_min_edge() -> f64 {
    0.05
}
fn default_max_buy_price() -> f64 {
    0.95
}
fn default_min_sell_price() -> f64 {
    0.05
}
fn default_min_size() -> f64 {
    1.0
}

impl Default for RiskLimits {
    fn default() -> Self {
        Self {
            max_notional_usdc: default_max_notional(),
            min_edge: default_min_edge(),
            max_buy_price: default_max_buy_price(),
            min_sell_price: default_min_sell_price(),
            min_size: default_min_size(),
        }
    }
}
