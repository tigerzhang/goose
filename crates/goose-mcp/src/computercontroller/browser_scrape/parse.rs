//! Pure parse/normalize of browser-captured page content into market-like fields.

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

/// One prediction-market style entry scraped from a page.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MarketEntry {
    /// Market question / title.
    pub title: String,
    /// Associated prices or odds (percentages, cents, or 0–1 decimals).
    pub prices: Vec<String>,
    /// Optional status string when present (active, closed, open, …).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    /// Optional outcome labels paired with prices when known.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub outcomes: Vec<String>,
}

/// Structured result of a check-and-scrape run.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ScrapeResult {
    pub url: String,
    pub title: String,
    pub markets: Vec<MarketEntry>,
    /// Short plain-text excerpt for debugging when markets are sparse.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub text_excerpt: String,
    /// Viewport PNG when [`super::ScrapeOptions::capture_screenshot`] was set.
    /// Omitted from JSON (raw bytes); MCP/CLI surface it as image content or a file.
    #[serde(skip)]
    pub screenshot_png: Option<Vec<u8>>,
}

/// Raw content acquired from a controlled browser (or a fixture).
#[derive(Debug, Clone)]
pub struct PageContent {
    pub url: String,
    pub title: String,
    pub text: String,
    pub html: String,
    /// In-page JSON blobs (e.g. `__NEXT_DATA__`, application/json scripts).
    pub json_blobs: Vec<String>,
    /// Optional viewport PNG captured from the live Chrome session.
    pub screenshot_png: Option<Vec<u8>>,
}

/// PNG file signature (ISO/IEC 15948).
pub const PNG_SIGNATURE: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

/// True when `bytes` look like a non-empty PNG (signature + non-trivial size).
pub fn is_valid_png(bytes: &[u8]) -> bool {
    bytes.len() > 1024 && bytes.starts_with(PNG_SIGNATURE)
}

/// Extract market-like structured fields from captured page content.
///
/// Pure and offline-testable: does not launch a browser.
pub fn extract_markets(content: &PageContent) -> ScrapeResult {
    let mut markets = Vec::new();

    for blob in &content.json_blobs {
        markets.extend(markets_from_json_blob(blob));
    }

    // Also try parsing HTML for embedded JSON arrays that look like markets.
    if markets.is_empty() {
        markets.extend(markets_from_html_embedded_json(&content.html));
    }

    // DOM / text heuristics for client-rendered listings.
    if markets.len() < 2 {
        let from_text = markets_from_text(&content.text);
        merge_markets(&mut markets, from_text);
    }

    if markets.is_empty() {
        let from_html_titles = markets_from_html_titles(&content.html);
        merge_markets(&mut markets, from_html_titles);
    }

    // Deduplicate by normalized title.
    markets = dedupe_markets(markets);

    let excerpt: String = content
        .text
        .chars()
        .take(500)
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");

    ScrapeResult {
        url: content.url.clone(),
        title: content.title.clone(),
        markets,
        text_excerpt: excerpt,
        // Attached by the browser session path; pure parse leaves this unset.
        screenshot_png: content.screenshot_png.clone(),
    }
}

fn merge_markets(into: &mut Vec<MarketEntry>, extra: Vec<MarketEntry>) {
    for m in extra {
        if !into
            .iter()
            .any(|e| normalize_title(&e.title) == normalize_title(&m.title))
        {
            into.push(m);
        }
    }
}

fn normalize_title(title: &str) -> String {
    title
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn dedupe_markets(markets: Vec<MarketEntry>) -> Vec<MarketEntry> {
    let mut out = Vec::new();
    for m in markets {
        if out
            .iter()
            .any(|e: &MarketEntry| normalize_title(&e.title) == normalize_title(&m.title))
        {
            continue;
        }
        out.push(m);
    }
    out
}

fn markets_from_json_blob(blob: &str) -> Vec<MarketEntry> {
    let trimmed = blob.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }

    let value: serde_json::Value = match serde_json::from_str(trimmed) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };

    let mut markets = Vec::new();
    collect_markets_from_value(&value, &mut markets, 0);
    markets
}

fn markets_from_html_embedded_json(html: &str) -> Vec<MarketEntry> {
    let mut markets = Vec::new();
    // Look for script tags with JSON that include "question" or "outcomePrices".
    static SCRIPT_RE: OnceLock<Regex> = OnceLock::new();
    let re = SCRIPT_RE.get_or_init(|| {
        Regex::new(r#"(?is)<script[^>]*type=["']application/(?:ld\+)?json["'][^>]*>(.*?)</script>"#)
            .expect("script regex")
    });
    for cap in re.captures_iter(html) {
        if let Some(m) = cap.get(1) {
            markets.extend(markets_from_json_blob(m.as_str()));
        }
    }
    markets
}

fn collect_markets_from_value(value: &serde_json::Value, out: &mut Vec<MarketEntry>, depth: usize) {
    if depth > 12 || out.len() > 200 {
        return;
    }

    match value {
        serde_json::Value::Array(arr) => {
            // Gamma-style market array: objects with question/outcomePrices.
            let mut array_markets = Vec::new();
            for item in arr {
                if let Some(m) = market_from_object(item) {
                    array_markets.push(m);
                }
            }
            if !array_markets.is_empty() {
                out.extend(array_markets);
                return;
            }
            for item in arr {
                collect_markets_from_value(item, out, depth + 1);
            }
        }
        serde_json::Value::Object(map) => {
            if let Some(m) = market_from_object(value) {
                out.push(m);
            }
            // Common Next.js / app state nesting.
            for key in ["markets", "data", "props", "pageProps", "queries", "events"] {
                if let Some(child) = map.get(key) {
                    collect_markets_from_value(child, out, depth + 1);
                }
            }
            // Walk remaining keys shallowly for nested market lists.
            if depth < 4 {
                for (k, child) in map {
                    if matches!(
                        k.as_str(),
                        "markets" | "data" | "props" | "pageProps" | "queries" | "events"
                    ) {
                        continue;
                    }
                    if child.is_array() || child.is_object() {
                        collect_markets_from_value(child, out, depth + 1);
                    }
                }
            }
        }
        _ => {}
    }
}

fn market_from_object(value: &serde_json::Value) -> Option<MarketEntry> {
    let obj = value.as_object()?;

    let title = obj
        .get("question")
        .or_else(|| obj.get("title"))
        .or_else(|| obj.get("name"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| s.len() >= 8)?;

    // Prefer explicit price fields used by Polymarket gamma API and similar.
    let mut prices = Vec::new();
    let mut outcomes = Vec::new();

    if let Some(op) = obj.get("outcomePrices") {
        prices.extend(parse_string_or_array_numbers(op));
    }
    if let Some(oc) = obj.get("outcomes") {
        outcomes.extend(parse_string_or_array_strings(oc));
    }
    if prices.is_empty() {
        if let Some(p) = obj.get("price").and_then(json_number_or_string) {
            prices.push(p);
        }
    }
    if prices.is_empty() {
        if let Some(p) = obj.get("lastTradePrice").and_then(json_number_or_string) {
            prices.push(p);
        }
    }
    if prices.is_empty() {
        if let Some(yes) = obj
            .get("yesPrice")
            .or_else(|| obj.get("yes"))
            .and_then(json_number_or_string)
        {
            prices.push(yes);
        }
        if let Some(no) = obj
            .get("noPrice")
            .or_else(|| obj.get("no"))
            .and_then(json_number_or_string)
        {
            prices.push(no);
        }
    }

    // Skip objects that look like markets but have no price-like data and no market markers.
    let looks_like_market = obj.contains_key("outcomePrices")
        || obj.contains_key("conditionId")
        || obj.contains_key("slug")
        || obj.contains_key("active")
        || obj.contains_key("closed")
        || !prices.is_empty();

    if !looks_like_market {
        return None;
    }

    let status = market_status_from_object(obj);

    Some(MarketEntry {
        title: title.to_string(),
        prices,
        status,
        outcomes,
    })
}

fn market_status_from_object(obj: &serde_json::Map<String, serde_json::Value>) -> Option<String> {
    if let Some(s) = obj.get("status").and_then(|v| v.as_str()) {
        return Some(s.to_string());
    }
    if obj.get("closed").and_then(|v| v.as_bool()) == Some(true) {
        return Some("closed".into());
    }
    if obj.get("active").and_then(|v| v.as_bool()) == Some(true) {
        return Some("active".into());
    }
    if obj.get("active").and_then(|v| v.as_bool()) == Some(false) {
        return Some("inactive".into());
    }
    None
}

fn parse_string_or_array_numbers(value: &serde_json::Value) -> Vec<String> {
    match value {
        serde_json::Value::String(s) => {
            // Often a JSON-encoded array string: "[\"0.5\",\"0.5\"]"
            if let Ok(inner) = serde_json::from_str::<serde_json::Value>(s) {
                return parse_string_or_array_numbers(&inner);
            }
            if is_price_like(s) {
                return vec![s.trim().to_string()];
            }
            Vec::new()
        }
        serde_json::Value::Array(arr) => arr
            .iter()
            .filter_map(json_number_or_string)
            .filter(|s| is_price_like(s))
            .collect(),
        serde_json::Value::Number(n) => vec![n.to_string()],
        _ => Vec::new(),
    }
}

fn parse_string_or_array_strings(value: &serde_json::Value) -> Vec<String> {
    match value {
        serde_json::Value::String(s) => {
            if let Ok(inner) = serde_json::from_str::<serde_json::Value>(s) {
                return parse_string_or_array_strings(&inner);
            }
            vec![s.clone()]
        }
        serde_json::Value::Array(arr) => arr
            .iter()
            .filter_map(|v| v.as_str().map(|s| s.to_string()))
            .collect(),
        _ => Vec::new(),
    }
}

fn json_number_or_string(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(s) => {
            let t = s.trim();
            if t.is_empty() {
                None
            } else {
                Some(t.to_string())
            }
        }
        serde_json::Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn is_price_like(s: &str) -> bool {
    let t = s.trim();
    if t.is_empty() {
        return false;
    }
    if t.ends_with('%') || t.ends_with('¢') || t.ends_with('c') {
        return true;
    }
    if let Ok(f) = t.parse::<f64>() {
        return (0.0..=1.0).contains(&f) || (1.0..=100.0).contains(&f);
    }
    // "62%" already handled; "0.505" handled by parse.
    false
}

fn markets_from_text(text: &str) -> Vec<MarketEntry> {
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();

    if lines.is_empty() {
        return Vec::new();
    }

    static PRICE_RE: OnceLock<Regex> = OnceLock::new();
    let price_re = PRICE_RE.get_or_init(|| {
        Regex::new(
            r"(?x)
            (?:Yes|No|YES|NO)?\s*
            (
                \d{1,3}(?:\.\d+)?%
                | \d{1,3}(?:\.\d+)?¢
                | 0?\.\d{1,4}
                | 1(?:\.0+)?
            )
            ",
        )
        .expect("price regex")
    });

    static STATUS_RE: OnceLock<Regex> = OnceLock::new();
    let status_re = STATUS_RE.get_or_init(|| {
        Regex::new(r"(?i)^(active|open|closed|resolved|inactive|paused)$").expect("status regex")
    });

    let mut markets = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        if looks_like_title(line) {
            let mut prices = Vec::new();
            let mut outcomes = Vec::new();
            let mut status = None;
            let mut j = i + 1;
            while j < lines.len() && j < i + 8 {
                let l = lines[j];
                if status_re.is_match(l) {
                    status = Some(l.to_lowercase());
                    j += 1;
                    break;
                }
                if looks_like_title(l) && !price_re.is_match(l) {
                    break;
                }
                for cap in price_re.captures_iter(l) {
                    if let Some(p) = cap.get(1) {
                        let price = p.as_str().to_string();
                        if !prices.contains(&price) {
                            prices.push(price);
                        }
                    }
                    if l.to_ascii_lowercase().contains("yes")
                        && !outcomes.iter().any(|o| o == "Yes")
                    {
                        outcomes.push("Yes".into());
                    }
                    if l.to_ascii_lowercase().contains("no") && !outcomes.iter().any(|o| o == "No")
                    {
                        outcomes.push("No".into());
                    }
                }
                j += 1;
            }
            if !prices.is_empty() {
                markets.push(MarketEntry {
                    title: line.to_string(),
                    prices,
                    status,
                    outcomes,
                });
                i = j;
                continue;
            }
        }
        i += 1;
    }
    markets
}

fn looks_like_title(line: &str) -> bool {
    let len = line.chars().count();
    if !(12..=200).contains(&len) {
        return false;
    }
    // Titles often end with ? or are sentence-like.
    if line.ends_with('?') {
        return true;
    }
    // Avoid pure price/nav lines.
    if line
        .chars()
        .all(|c| c.is_ascii_digit() || "%¢. ".contains(c))
    {
        return false;
    }
    let words = line.split_whitespace().count();
    words >= 3
        && !line.eq_ignore_ascii_case("sign up")
        && !line.eq_ignore_ascii_case("log in")
        && !line.starts_with("http")
}

fn markets_from_html_titles(html: &str) -> Vec<MarketEntry> {
    static TITLE_RE: OnceLock<Regex> = OnceLock::new();
    let re = TITLE_RE.get_or_init(|| {
        Regex::new(r#"(?is)<(?:h[1-3]|a)[^>]*class="[^"]*market[^"]*"[^>]*>(.*?)</(?:h[1-3]|a)>"#)
            .expect("title regex")
    });

    static STRIP_RE: OnceLock<Regex> = OnceLock::new();
    let strip = STRIP_RE.get_or_init(|| Regex::new(r"<[^>]+>").expect("strip tags"));

    static PRICE_NEAR_RE: OnceLock<Regex> = OnceLock::new();
    let price_near = PRICE_NEAR_RE.get_or_init(|| {
        Regex::new(r"(\d{1,3}(?:\.\d+)?%|\d{1,3}(?:\.\d+)?¢|0?\.\d{2,4})").expect("price near")
    });

    let mut markets = Vec::new();
    for cap in re.captures_iter(html) {
        if let Some(m) = cap.get(1) {
            let title = strip.replace_all(m.as_str(), "").trim().to_string();
            if !looks_like_title(&title) && !title.ends_with('?') {
                continue;
            }
            // Search a window after the match for prices.
            let start = m.end();
            let window = html.get(start..start.saturating_add(400)).unwrap_or("");
            let prices: Vec<String> = price_near
                .captures_iter(window)
                .filter_map(|c| c.get(1).map(|p| p.as_str().to_string()))
                .take(4)
                .collect();
            if !prices.is_empty() {
                markets.push(MarketEntry {
                    title,
                    prices,
                    status: None,
                    outcomes: vec![],
                });
            }
        }
    }
    markets
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_returns_empty_markets_for_blank_content() {
        let content = PageContent {
            url: "http://x".into(),
            title: "x".into(),
            text: String::new(),
            html: String::new(),
            json_blobs: vec![],
            screenshot_png: None,
        };
        let r = extract_markets(&content);
        assert!(r.markets.is_empty());
        assert_eq!(r.url, "http://x");
        assert!(r.screenshot_png.is_none());
    }

    #[test]
    fn extract_forwards_screenshot_png_bytes() {
        let mut png = PNG_SIGNATURE.to_vec();
        png.extend(std::iter::repeat_n(0u8, 1200));
        let content = PageContent {
            url: "http://x".into(),
            title: "x".into(),
            text: String::new(),
            html: String::new(),
            json_blobs: vec![],
            screenshot_png: Some(png.clone()),
        };
        let r = extract_markets(&content);
        assert_eq!(r.screenshot_png.as_deref(), Some(png.as_slice()));
        assert!(is_valid_png(r.screenshot_png.as_ref().unwrap()));
    }

    #[test]
    fn is_valid_png_rejects_empty_and_non_png() {
        assert!(!is_valid_png(&[]));
        assert!(!is_valid_png(b"not a png"));
        assert!(!is_valid_png(PNG_SIGNATURE)); // too short
        let mut ok = PNG_SIGNATURE.to_vec();
        ok.resize(1100, 1);
        assert!(is_valid_png(&ok));
    }

    #[test]
    fn gamma_outcome_prices_string_array_parsed() {
        let blob = r#"{"question":"Test market question here?","outcomePrices":"[\"0.7\",\"0.3\"]","outcomes":"[\"Yes\",\"No\"]","active":true}"#;
        let markets = markets_from_json_blob(blob);
        assert_eq!(markets.len(), 1);
        assert_eq!(markets[0].prices, vec!["0.7", "0.3"]);
        assert_eq!(markets[0].outcomes, vec!["Yes", "No"]);
        assert_eq!(markets[0].status.as_deref(), Some("active"));
    }
}
