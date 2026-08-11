//! Browser-based Polymarket discovery via headless Chrome.

use super::api::{browser_entry_to_summary, POLYMARKET_WEB};
use super::types::MarketSummary;
use crate::computercontroller::{check_and_scrape, is_valid_png, ScrapeOptions, ScrapeResult};
use std::time::Duration;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum BrowserError {
    #[error("{0}")]
    Scrape(#[from] crate::computercontroller::BrowserScrapeError),
}

#[derive(Debug, Clone)]
pub struct BrowserScrapeRequest {
    pub url: String,
    pub settle_ms: u64,
    pub timeout_secs: u64,
    pub ready_selector: Option<String>,
    pub capture_screenshot: bool,
}

impl Default for BrowserScrapeRequest {
    fn default() -> Self {
        Self {
            url: POLYMARKET_WEB.to_string(),
            settle_ms: 3_000,
            timeout_secs: 45,
            ready_selector: None,
            capture_screenshot: false,
        }
    }
}

#[derive(Debug, Clone)]
pub struct BrowserMarketsResult {
    pub page_url: String,
    pub page_title: String,
    pub markets: Vec<MarketSummary>,
    pub text_excerpt: String,
    pub screenshot_png: Option<Vec<u8>>,
}

/// Scrape Polymarket (or a market URL) with a real browser and normalize markets.
pub async fn scrape_markets(
    req: BrowserScrapeRequest,
) -> Result<BrowserMarketsResult, BrowserError> {
    let options = ScrapeOptions {
        settle_ms: req.settle_ms,
        ready_selector: req.ready_selector,
        navigation_timeout: Duration::from_secs(req.timeout_secs),
        chrome_path: None,
        no_sandbox: true,
        capture_screenshot: req.capture_screenshot,
    };

    let result: ScrapeResult = check_and_scrape(&req.url, options).await?;

    let markets = result
        .markets
        .iter()
        .map(|m| {
            browser_entry_to_summary(
                &m.title,
                &m.prices,
                &m.outcomes,
                m.status.as_deref(),
                &result.url,
            )
        })
        .collect();

    let screenshot_png =
        result
            .screenshot_png
            .and_then(|png| if is_valid_png(&png) { Some(png) } else { None });

    Ok(BrowserMarketsResult {
        page_url: result.url,
        page_title: result.title,
        markets,
        text_excerpt: result.text_excerpt,
        screenshot_png,
    })
}

/// Build a Polymarket event/market URL from a slug when possible.
pub fn market_url_from_slug(slug: &str) -> String {
    let slug = slug.trim().trim_start_matches('/');
    if slug.starts_with("http://") || slug.starts_with("https://") {
        return slug.to_string();
    }
    if slug.starts_with("event/") || slug.starts_with("market/") {
        return format!("{POLYMARKET_WEB}/{slug}");
    }
    // Default to event path (most share links).
    format!("{POLYMARKET_WEB}/event/{slug}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn market_url_from_slug_variants() {
        assert_eq!(
            market_url_from_slug("foo-bar"),
            "https://polymarket.com/event/foo-bar"
        );
        assert_eq!(
            market_url_from_slug("event/foo-bar"),
            "https://polymarket.com/event/foo-bar"
        );
        assert_eq!(
            market_url_from_slug("https://polymarket.com/event/x"),
            "https://polymarket.com/event/x"
        );
    }
}
