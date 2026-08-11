//! Polymarket MCP: API + browser market discovery, LLM analysis context, order intents.
//!
//! # Tools
//!
//! **API (preferred for trading data)**
//! - `list_markets`, `list_events`, `get_market`, `search`
//! - `get_order_book`, `get_price`, `get_positions`
//! - `prepare_analysis_context` — market + books packaged for LLM scoring
//!
//! **Browser (JS-rendered UI)**
//! - `browser_scrape_markets` — headless Chrome scrape of polymarket.com or a market URL
//!
//! **Strategy / orders (paper-first)**
//! - `build_order_intent` — risk-checked limit intent (`dry_run` default true)
//! - `place_order` — dry-run by default; live only with env + pre-signed order JSON
//!
//! Live order signing (EIP-712) is not performed in-process. Use Polymarket's
//! official Python/TS clients to sign, then pass the signed body to `place_order`,
//! or keep `dry_run: true` for paper trading.

mod api;
mod browser;
mod strategy;
mod types;

pub use api::{ApiError, ListQuery, PolymarketApi, CLOB_API, DATA_API, GAMMA_API, POLYMARKET_WEB};
pub use browser::{scrape_markets, BrowserError, BrowserMarketsResult, BrowserScrapeRequest};
pub use strategy::{build_order_intent, suggest_limit_price, BuildOrderRequest};
pub use types::*;

use api::PolymarketApi as Api;
use base64::Engine;
use indoc::formatdoc;
use rmcp::{
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::{
        CallToolResult, Content, ErrorCode, ErrorData, Implementation, InitializeResult,
        ServerCapabilities, ServerInfo,
    },
    schemars::JsonSchema,
    tool, tool_handler, tool_router, ServerHandler,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Parameters for list_markets
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct ListMarketsParams {
    /// Max markets to return (1–100, default 20)
    #[serde(default)]
    pub limit: Option<u32>,
    /// Offset for pagination (default 0)
    #[serde(default)]
    pub offset: Option<u32>,
    /// Only active markets (default true)
    #[serde(default)]
    pub active: Option<bool>,
    /// Include closed markets (default false)
    #[serde(default)]
    pub closed: Option<bool>,
    /// Sort field, e.g. volume24hr, liquidity, endDate
    #[serde(default)]
    pub order: Option<String>,
    /// Sort ascending (default false = descending)
    #[serde(default)]
    pub ascending: Option<bool>,
    /// Optional Gamma tag id filter
    #[serde(default)]
    pub tag_id: Option<String>,
}

/// Parameters for list_events
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct ListEventsParams {
    #[serde(default)]
    pub limit: Option<u32>,
    #[serde(default)]
    pub offset: Option<u32>,
    #[serde(default)]
    pub active: Option<bool>,
    #[serde(default)]
    pub closed: Option<bool>,
    #[serde(default)]
    pub order: Option<String>,
    #[serde(default)]
    pub ascending: Option<bool>,
}

/// Parameters for get_market
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct GetMarketParams {
    /// Market id (numeric) or slug
    pub id_or_slug: String,
}

/// Parameters for search
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct SearchParams {
    pub query: String,
    /// Results per type (default 5, max 20)
    #[serde(default)]
    pub limit_per_type: Option<u32>,
}

/// Parameters for get_order_book
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct GetOrderBookParams {
    /// CLOB outcome token id
    pub token_id: String,
    /// Max levels per side to return (optional)
    #[serde(default)]
    pub depth: Option<u32>,
}

/// Parameters for get_price
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct GetPriceParams {
    pub token_id: String,
    /// buy or sell (default buy)
    #[serde(default)]
    pub side: Option<String>,
    /// Also fetch midpoint (default true)
    #[serde(default)]
    pub include_midpoint: Option<bool>,
}

/// Parameters for get_positions
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct GetPositionsParams {
    /// Wallet address (0x…)
    pub user: String,
}

/// Parameters for browser_scrape_markets
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct BrowserScrapeMarketsParams {
    /// URL to open (default https://polymarket.com). Use event/market URLs for detail pages.
    #[serde(default)]
    pub url: Option<String>,
    /// Or pass a market/event slug; ignored if url is set
    #[serde(default)]
    pub slug: Option<String>,
    /// Extra wait after page ready for SPA render (ms, default 3000)
    #[serde(default)]
    pub settle_ms: Option<u64>,
    /// Navigation timeout seconds (default 45)
    #[serde(default)]
    pub timeout_secs: Option<u64>,
    /// Optional CSS selector that must appear before extraction
    #[serde(default)]
    pub ready_selector: Option<String>,
    /// Capture viewport PNG (default false)
    #[serde(default)]
    pub capture_screenshot: bool,
}

/// Parameters for prepare_analysis_context
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct PrepareAnalysisParams {
    /// Market id or slug (API path)
    pub id_or_slug: String,
    /// Include order books for YES/NO tokens when available (default true)
    #[serde(default)]
    pub include_books: Option<bool>,
    /// Book depth per side (default 5)
    #[serde(default)]
    pub book_depth: Option<u32>,
}

/// Parameters for build_order_intent / place_order
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct OrderParams {
    /// CLOB token id for the outcome
    pub token_id: String,
    /// buy or sell
    pub side: String,
    /// Limit price in 0–1
    pub price: f64,
    /// Size in shares
    pub size: f64,
    /// GTC, GTD, FOK, FAK (default GTC)
    #[serde(default)]
    pub order_type: Option<String>,
    #[serde(default)]
    pub market_id: Option<String>,
    #[serde(default)]
    pub market_question: Option<String>,
    #[serde(default)]
    pub rationale: Option<String>,
    /// Model/estimated fair probability (0–1); used for edge checks
    #[serde(default)]
    pub fair_prob: Option<f64>,
    /// Paper trade when true (default true). Live requires env + confirm.
    #[serde(default)]
    pub dry_run: Option<bool>,
    /// Required true for any non-dry-run submission
    #[serde(default)]
    pub confirm_live: bool,
    /// Optional risk limit overrides
    #[serde(default)]
    pub max_notional_usdc: Option<f64>,
    #[serde(default)]
    pub min_edge: Option<f64>,
    /// Pre-signed CLOB order JSON (from py-clob-client / official SDK). Required for live.
    #[serde(default)]
    pub signed_order: Option<Value>,
}

/// Polymarket MCP Server
#[derive(Clone)]
pub struct PolymarketServer {
    tool_router: ToolRouter<Self>,
    api: Api,
    instructions: String,
}

impl Default for PolymarketServer {
    fn default() -> Self {
        Self::new()
    }
}

#[tool_router(router = tool_router)]
impl PolymarketServer {
    pub fn new() -> Self {
        let instructions = formatdoc! {r#"
            Polymarket extension: discover prediction markets via official APIs and/or a real
            browser, prepare structured context for LLM analysis, and build risk-checked order
            intents. Prefer APIs for prices and token IDs; use the browser for UI/narrative pages.

            ## Recommended workflow
            1. list_markets or search — find liquid markets (API)
            2. get_market + get_order_book / get_price — trading data (API)
            3. Optional: browser_scrape_markets — what the site shows (Chrome required)
            4. prepare_analysis_context — pack market + books for your analysis
            5. Score fair probability yourself (LLM); call build_order_intent with fair_prob
            6. place_order with dry_run=true (default) for paper; live needs:
               - POLYMARKET_ENABLE_LIVE_ORDERS=1
               - confirm_live=true
               - signed_order JSON from Polymarket's official signer (py-clob-client / TS SDK)

            ## APIs used
            - Gamma: {gamma} (markets, events, search)
            - CLOB:  {clob} (books, prices; POST /order for signed orders)
            - Data:  {data} (positions by wallet)
            - Web:   {web}

            ## Safety
            - dry_run defaults to true; never place live orders without explicit confirm_live
            - Risk caps: max notional, min edge (when fair_prob set), price bounds
            - This extension does not hold private keys or perform EIP-712 signing
            - You are responsible for jurisdiction, ToS, and financial risk
            "#,
            gamma = GAMMA_API,
            clob = CLOB_API,
            data = DATA_API,
            web = POLYMARKET_WEB,
        };

        Self {
            tool_router: Self::tool_router(),
            api: Api::new(),
            instructions,
        }
    }

    fn json_result(value: &impl Serialize) -> Result<CallToolResult, ErrorData> {
        let text = serde_json::to_string_pretty(value).map_err(|e| {
            ErrorData::new(
                ErrorCode::INTERNAL_ERROR,
                format!("serialize failed: {e}"),
                None,
            )
        })?;
        Ok(CallToolResult::success(vec![Content::text(text)]))
    }

    fn api_err(e: ApiError) -> ErrorData {
        ErrorData::new(ErrorCode::INTERNAL_ERROR, e.to_string(), None)
    }

    fn parse_side(s: &str) -> Result<OrderSide, ErrorData> {
        match s.trim().to_ascii_lowercase().as_str() {
            "buy" | "b" => Ok(OrderSide::Buy),
            "sell" | "s" => Ok(OrderSide::Sell),
            other => Err(ErrorData::new(
                ErrorCode::INVALID_PARAMS,
                format!("side must be buy or sell, got '{other}'"),
                None,
            )),
        }
    }

    fn parse_order_type(s: Option<&str>) -> IntentOrderType {
        match s.map(|x| x.trim().to_ascii_uppercase()).as_deref() {
            Some("GTD") => IntentOrderType::Gtd,
            Some("FOK") => IntentOrderType::Fok,
            Some("FAK") => IntentOrderType::Fak,
            _ => IntentOrderType::Gtc,
        }
    }

    fn risk_limits_from(params: &OrderParams) -> RiskLimits {
        let mut limits = RiskLimits::default();
        if let Some(n) = params.max_notional_usdc {
            limits.max_notional_usdc = n;
        }
        if let Some(e) = params.min_edge {
            limits.min_edge = e;
        }
        limits
    }

    /// List markets via Gamma API (normalized summaries).
    #[tool(
        name = "list_markets",
        description = "List Polymarket markets via the Gamma API. Returns normalized summaries with questions, prices, token IDs, volume, liquidity. Prefer this over browser for structured trading data."
    )]
    pub async fn list_markets(
        &self,
        params: Parameters<ListMarketsParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let p = params.0;
        let markets = self
            .api
            .list_markets(ListQuery {
                limit: p.limit.unwrap_or(20),
                offset: p.offset.unwrap_or(0),
                active: Some(p.active.unwrap_or(true)),
                closed: Some(p.closed.unwrap_or(false)),
                order: p.order.as_deref(),
                ascending: p.ascending,
                tag_id: p.tag_id.as_deref(),
            })
            .await
            .map_err(Self::api_err)?;
        Self::json_result(&serde_json::json!({
            "count": markets.len(),
            "source": "api",
            "markets": markets,
        }))
    }

    /// List events via Gamma API (raw-ish event objects with nested markets).
    #[tool(
        name = "list_events",
        description = "List Polymarket events via the Gamma API. Events group one or more markets under a shared title. Returns API JSON."
    )]
    pub async fn list_events(
        &self,
        params: Parameters<ListEventsParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let p = params.0;
        let events = self
            .api
            .list_events(ListQuery {
                limit: p.limit.unwrap_or(20),
                offset: p.offset.unwrap_or(0),
                active: Some(p.active.unwrap_or(true)),
                closed: Some(p.closed.unwrap_or(false)),
                order: p.order.as_deref(),
                ascending: p.ascending,
                tag_id: None,
            })
            .await
            .map_err(Self::api_err)?;
        Self::json_result(&serde_json::json!({
            "source": "api",
            "events": events,
        }))
    }

    /// Fetch one market by id or slug.
    #[tool(
        name = "get_market",
        description = "Fetch a single market by numeric id or slug via Gamma API. Includes clob_token_ids needed for order books and orders."
    )]
    pub async fn get_market(
        &self,
        params: Parameters<GetMarketParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let market = self
            .api
            .get_market(&params.0.id_or_slug)
            .await
            .map_err(Self::api_err)?;
        Self::json_result(&market)
    }

    /// Public search.
    #[tool(
        name = "search",
        description = "Search Polymarket (events, tags, profiles) via Gamma public-search API."
    )]
    pub async fn search(
        &self,
        params: Parameters<SearchParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let p = params.0;
        let result = self
            .api
            .search(&p.query, p.limit_per_type.unwrap_or(5))
            .await
            .map_err(Self::api_err)?;
        Self::json_result(&serde_json::json!({
            "source": "api",
            "query": p.query,
            "result": result,
        }))
    }

    /// CLOB order book.
    #[tool(
        name = "get_order_book",
        description = "Fetch the CLOB order book for an outcome token_id. Returns bids, asks, best bid/ask, midpoint when available."
    )]
    pub async fn get_order_book(
        &self,
        params: Parameters<GetOrderBookParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let p = params.0;
        let book = self
            .api
            .get_order_book(&p.token_id, p.depth.map(|d| d as usize))
            .await
            .map_err(Self::api_err)?;
        Self::json_result(&book)
    }

    /// CLOB price (+ optional midpoint).
    #[tool(
        name = "get_price",
        description = "Fetch CLOB price for a token_id and side (buy/sell). Optionally includes midpoint."
    )]
    pub async fn get_price(
        &self,
        params: Parameters<GetPriceParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let p = params.0;
        let side = p.side.as_deref().unwrap_or("buy");
        let price = self
            .api
            .get_price(&p.token_id, side)
            .await
            .map_err(Self::api_err)?;
        let mut out = serde_json::json!({
            "token_id": p.token_id,
            "side": side,
            "price": price,
            "source": "api",
        });
        if p.include_midpoint.unwrap_or(true) {
            if let Ok(mid) = self.api.get_midpoint(&p.token_id).await {
                out["midpoint"] = serde_json::json!(mid);
            }
        }
        Self::json_result(&out)
    }

    /// Positions for a wallet.
    #[tool(
        name = "get_positions",
        description = "Fetch open positions for a wallet address via Polymarket Data API (public)."
    )]
    pub async fn get_positions(
        &self,
        params: Parameters<GetPositionsParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let positions = self
            .api
            .get_positions(&params.0.user)
            .await
            .map_err(Self::api_err)?;
        Self::json_result(&serde_json::json!({
            "source": "api",
            "user": params.0.user,
            "positions": positions,
        }))
    }

    /// Browser scrape of Polymarket UI.
    #[tool(
        name = "browser_scrape_markets",
        description = "Open a real headless Chrome browser on Polymarket (or a market URL), wait for JS render, and extract market-like titles/prices. Requires Chrome/Chromium. Use for UI/narrative; prefer API tools for token IDs and books. Optional capture_screenshot."
    )]
    pub async fn browser_scrape_markets(
        &self,
        params: Parameters<BrowserScrapeMarketsParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let p = params.0;
        let url = if let Some(u) = p.url.filter(|s| !s.trim().is_empty()) {
            u
        } else if let Some(slug) = p.slug.filter(|s| !s.trim().is_empty()) {
            browser::market_url_from_slug(&slug)
        } else {
            POLYMARKET_WEB.to_string()
        };

        let result = browser::scrape_markets(BrowserScrapeRequest {
            url,
            settle_ms: p.settle_ms.unwrap_or(3_000),
            timeout_secs: p.timeout_secs.unwrap_or(45),
            ready_selector: p.ready_selector,
            capture_screenshot: p.capture_screenshot,
        })
        .await
        .map_err(|e| {
            ErrorData::new(
                ErrorCode::INTERNAL_ERROR,
                format!("browser_scrape_markets failed: {e}"),
                None,
            )
        })?;

        let payload = serde_json::json!({
            "source": "browser",
            "page_url": result.page_url,
            "page_title": result.page_title,
            "count": result.markets.len(),
            "markets": result.markets,
            "text_excerpt": result.text_excerpt,
        });

        let mut messages = vec![Content::text(
            serde_json::to_string_pretty(&payload).map_err(|e| {
                ErrorData::new(
                    ErrorCode::INTERNAL_ERROR,
                    format!("serialize failed: {e}"),
                    None,
                )
            })?,
        )];

        if let Some(png) = result.screenshot_png {
            let data = base64::prelude::BASE64_STANDARD.encode(&png);
            messages.push(Content::image(data, "image/png"));
        }

        Ok(CallToolResult::success(messages))
    }

    /// Pack market + books for LLM analysis.
    #[tool(
        name = "prepare_analysis_context",
        description = "Fetch a market via API and optional YES/NO order books, return a compact AnalysisContext JSON plus hints for LLM fair-probability scoring. Use before build_order_intent."
    )]
    pub async fn prepare_analysis_context(
        &self,
        params: Parameters<PrepareAnalysisParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let p = params.0;
        let market = self
            .api
            .get_market(&p.id_or_slug)
            .await
            .map_err(Self::api_err)?;

        let include_books = p.include_books.unwrap_or(true);
        let depth = p.book_depth.unwrap_or(5) as usize;

        let mut yes_book = None;
        let mut no_book = None;
        if include_books {
            if let Some(yes_id) = market.clob_token_ids.first() {
                yes_book = self.api.get_order_book(yes_id, Some(depth)).await.ok();
            }
            if let Some(no_id) = market.clob_token_ids.get(1) {
                no_book = self.api.get_order_book(no_id, Some(depth)).await.ok();
            }
        }

        let context = AnalysisContext {
            market,
            yes_book,
            no_book,
            analysis_prompt_hints: vec![
                "Estimate fair_prob for YES in [0,1] with calibrated confidence.".into(),
                "Compare fair_prob to best ask (buy) or best bid (sell); require edge > fees/spread.".into(),
                "Read resolution criteria carefully; flag ambiguous markets as skip.".into(),
                "Do not invent token_ids — use clob_token_ids from this context.".into(),
                "Return structured JSON: {fair_prob_yes, confidence, action, rationale, risks}.".into(),
            ],
        };

        Self::json_result(&context)
    }

    /// Build a risk-checked order intent (paper by default).
    #[tool(
        name = "build_order_intent",
        description = "Build a risk-checked limit order intent. dry_run defaults to true (paper). Pass fair_prob to enforce min edge. Does not submit to the exchange."
    )]
    pub async fn build_order_intent_tool(
        &self,
        params: Parameters<OrderParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let p = params.0;
        let dry_run = p.dry_run.unwrap_or(true);
        if !dry_run && !p.confirm_live {
            return Err(ErrorData::new(
                ErrorCode::INVALID_PARAMS,
                "non-dry-run requires confirm_live=true (prefer dry_run=true for paper intents)",
                None,
            ));
        }

        let side = Self::parse_side(&p.side)?;
        let limits = Self::risk_limits_from(&p);
        let intent = build_order_intent(BuildOrderRequest {
            token_id: p.token_id,
            side,
            price: p.price,
            size: p.size,
            order_type: Self::parse_order_type(p.order_type.as_deref()),
            market_id: p.market_id,
            market_question: p.market_question,
            rationale: p.rationale,
            fair_prob: p.fair_prob,
            dry_run: true, // build_order_intent is always paper; place_order handles live
            limits,
        })
        .map_err(|e| ErrorData::new(ErrorCode::INVALID_PARAMS, e, None))?;

        Self::json_result(&serde_json::json!({
            "status": "intent_ready",
            "intent": intent,
            "next_step": "Call place_order with the same params (dry_run true for paper log, or signed_order + confirm_live for live).",
        }))
    }

    /// Place order: dry-run log or submit pre-signed order.
    #[tool(
        name = "place_order",
        description = "Place an order intent. Default dry_run=true returns a paper order record only. Live submission requires confirm_live=true, POLYMARKET_ENABLE_LIVE_ORDERS=1, and signed_order JSON from Polymarket's official SDK (this tool does not sign EIP-712 orders)."
    )]
    pub async fn place_order(
        &self,
        params: Parameters<OrderParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let p = params.0;
        let dry_run = p.dry_run.unwrap_or(true);

        if !dry_run {
            if !p.confirm_live {
                return Err(ErrorData::new(
                    ErrorCode::INVALID_PARAMS,
                    "live place_order requires confirm_live=true",
                    None,
                ));
            }
            let live_enabled = std::env::var("POLYMARKET_ENABLE_LIVE_ORDERS")
                .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
                .unwrap_or(false);
            if !live_enabled {
                return Err(ErrorData::new(
                    ErrorCode::INVALID_PARAMS,
                    "live orders disabled: set POLYMARKET_ENABLE_LIVE_ORDERS=1",
                    None,
                ));
            }
            let Some(signed) = p.signed_order.as_ref() else {
                return Err(ErrorData::new(
                    ErrorCode::INVALID_PARAMS,
                    "live place_order requires signed_order JSON (EIP-712 signed via py-clob-client or official TS SDK). Unsigned intents are paper-only.",
                    None,
                ));
            };

            // Still run risk checks on the intent params when provided.
            let side = Self::parse_side(&p.side)?;
            let limits = Self::risk_limits_from(&p);
            let intent = build_order_intent(BuildOrderRequest {
                token_id: p.token_id.clone(),
                side,
                price: p.price,
                size: p.size,
                order_type: Self::parse_order_type(p.order_type.as_deref()),
                market_id: p.market_id.clone(),
                market_question: p.market_question.clone(),
                rationale: p.rationale.clone(),
                fair_prob: p.fair_prob,
                dry_run: false,
                limits,
            })
            .map_err(|e| ErrorData::new(ErrorCode::INVALID_PARAMS, e, None))?;

            let response = self
                .api
                .submit_signed_order(signed)
                .await
                .map_err(Self::api_err)?;

            return Self::json_result(&serde_json::json!({
                "status": "submitted",
                "dry_run": false,
                "intent": intent,
                "clob_response": response,
            }));
        }

        let side = Self::parse_side(&p.side)?;
        let limits = Self::risk_limits_from(&p);
        let intent = build_order_intent(BuildOrderRequest {
            token_id: p.token_id,
            side,
            price: p.price,
            size: p.size,
            order_type: Self::parse_order_type(p.order_type.as_deref()),
            market_id: p.market_id,
            market_question: p.market_question,
            rationale: p.rationale,
            fair_prob: p.fair_prob,
            dry_run: true,
            limits,
        })
        .map_err(|e| ErrorData::new(ErrorCode::INVALID_PARAMS, e, None))?;

        Self::json_result(&serde_json::json!({
            "status": "paper_filled_logged",
            "dry_run": true,
            "intent": intent,
            "note": "Paper order only — no exchange submission. For live, pass dry_run=false, confirm_live=true, signed_order, and POLYMARKET_ENABLE_LIVE_ORDERS=1.",
        }))
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for PolymarketServer {
    fn get_info(&self) -> ServerInfo {
        InitializeResult::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new(
                "goose-polymarket",
                env!("CARGO_PKG_VERSION"),
            ))
            .with_instructions(self.instructions.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn server_info_has_instructions() {
        let server = PolymarketServer::new();
        let info = server.get_info();
        assert_eq!(info.server_info.name, "goose-polymarket");
        let instr = info.instructions.unwrap();
        assert!(instr.contains("list_markets"));
        assert!(instr.contains("browser_scrape_markets"));
        assert!(instr.contains("dry_run"));
    }

    #[tokio::test]
    async fn build_order_intent_tool_paper() {
        let server = PolymarketServer::new();
        let params = Parameters(OrderParams {
            token_id: "tok".into(),
            side: "buy".into(),
            price: 0.3,
            size: 5.0,
            order_type: None,
            market_id: None,
            market_question: Some("Test?".into()),
            rationale: Some("unit test".into()),
            fair_prob: Some(0.5),
            dry_run: Some(true),
            confirm_live: false,
            max_notional_usdc: None,
            min_edge: None,
            signed_order: None,
        });
        let result = server.build_order_intent_tool(params).await.unwrap();
        assert!(!result.content.is_empty());
    }
}
