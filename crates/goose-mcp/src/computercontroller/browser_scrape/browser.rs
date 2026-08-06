//! Browser session lifecycle: launch Chrome, navigate, wait for ready, extract page state.

use super::parse::{extract_markets, PageContent, ScrapeResult};
use chromiumoxide::browser::{Browser, BrowserConfig};
use chromiumoxide::cdp::browser_protocol::page::CaptureScreenshotFormat;
use chromiumoxide::page::ScreenshotParams;
use futures::StreamExt;
use std::path::PathBuf;
use std::time::Duration;
use thiserror::Error;

/// Options controlling navigation and wait-for-ready behaviour.
#[derive(Debug, Clone)]
pub struct ScrapeOptions {
    /// Extra settle time after load / ready selector (milliseconds).
    pub settle_ms: u64,
    /// Optional CSS selector that must appear before extraction.
    pub ready_selector: Option<String>,
    /// Max time to wait for navigation and ready conditions.
    pub navigation_timeout: Duration,
    /// Override Chrome/Chromium executable path.
    pub chrome_path: Option<PathBuf>,
    /// Run with `--no-sandbox` (often required in CI/containers).
    pub no_sandbox: bool,
    /// When true, capture a viewport PNG after the page is ready (default false).
    pub capture_screenshot: bool,
}

impl Default for ScrapeOptions {
    fn default() -> Self {
        Self {
            settle_ms: 2_500,
            ready_selector: None,
            // Polymarket-class SPAs behind local proxies often exceed 30s first paint.
            navigation_timeout: Duration::from_secs(90),
            chrome_path: None,
            no_sandbox: true,
            capture_screenshot: false,
        }
    }
}

#[derive(Debug, Error)]
pub enum BrowserScrapeError {
    #[error("failed to locate Chrome/Chromium executable: {0}")]
    ChromeNotFound(String),
    #[error("failed to launch browser: {0}")]
    Launch(String),
    #[error("navigation failed for {url}: {message}")]
    Navigation { url: String, message: String },
    #[error("timed out waiting for page ready: {0}")]
    ReadyTimeout(String),
    #[error("failed to extract page content: {0}")]
    Extract(String),
    #[error("browser protocol error: {0}")]
    Protocol(String),
}

/// Read proxy settings from common environment variables for Chrome `--proxy-server`.
fn detect_proxy_server() -> Option<String> {
    for key in [
        "HTTPS_PROXY",
        "https_proxy",
        "HTTP_PROXY",
        "http_proxy",
        "ALL_PROXY",
        "all_proxy",
    ] {
        if let Ok(val) = std::env::var(key) {
            let trimmed = val.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

/// Locate a Chrome/Chromium binary on the system.
pub fn find_chrome_executable(explicit: Option<&PathBuf>) -> Result<PathBuf, BrowserScrapeError> {
    if let Some(path) = explicit {
        if path.is_file() {
            return Ok(path.clone());
        }
        return Err(BrowserScrapeError::ChromeNotFound(format!(
            "configured path is not a file: {}",
            path.display()
        )));
    }

    let candidates = [
        "google-chrome",
        "google-chrome-stable",
        "chromium",
        "chromium-browser",
        "chrome",
    ];
    for name in candidates {
        if let Ok(path) = which::which(name) {
            return Ok(path);
        }
    }

    // Common absolute install locations (Linux / macOS).
    let absolute = [
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ];
    for path in absolute {
        let p = PathBuf::from(path);
        if p.is_file() {
            return Ok(p);
        }
    }

    Err(BrowserScrapeError::ChromeNotFound(
        "no Chrome/Chromium binary found on PATH or common install locations".into(),
    ))
}

/// Navigate to `url`, wait until client-rendered content is available, and
/// return raw page content captured from the controlled browser.
pub async fn navigate_and_extract(
    url: &str,
    options: ScrapeOptions,
) -> Result<PageContent, BrowserScrapeError> {
    let chrome = find_chrome_executable(options.chrome_path.as_ref())?;

    // Fresh profile per launch avoids shared-profile races (ERR_NETWORK_CHANGED).
    let profile_dir = tempfile::tempdir().map_err(|e| {
        BrowserScrapeError::Launch(format!("failed to create chrome profile dir: {e}"))
    })?;

    let mut builder = BrowserConfig::builder()
        .chrome_executable(&chrome)
        .window_size(1280, 900)
        .request_timeout(options.navigation_timeout)
        .user_data_dir(profile_dir.path());

    if options.no_sandbox {
        builder = builder.no_sandbox();
    }

    // chromiumoxide prefixes keys with `--` and formats values as `--key=value`.
    // Do not include a leading `--` in keys.
    builder = builder
        .arg("disable-dev-shm-usage")
        .arg("disable-gpu")
        .arg("disable-extensions")
        .arg("no-first-run")
        .arg("no-default-browser-check")
        .arg("disable-features=TranslateUI")
        .arg((
            "user-agent",
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 GooseBrowserScrape/1.0",
        ));

    // Chrome does not inherit http(s)_proxy; pass proxy-server when set.
    // Bypass loopback so CDP / local services are not sent through the proxy.
    if let Some(proxy) = detect_proxy_server() {
        builder = builder
            .arg(("proxy-server", proxy.as_str()))
            .arg(("proxy-bypass-list", "<-loopback>"));
    }

    let config = builder
        .build()
        .map_err(|e| BrowserScrapeError::Launch(e.to_string()))?;

    let (mut browser, mut handler) = Browser::launch(config)
        .await
        .map_err(|e| BrowserScrapeError::Launch(e.to_string()))?;

    let handler_task = tokio::spawn(async move {
        while let Some(event) = handler.next().await {
            if event.is_err() {
                break;
            }
        }
    });

    // Keep profile_dir alive until browser exits.
    let result = async {
        // Brief pause so the browser process finishes wiring networking/proxy.
        tokio::time::sleep(Duration::from_millis(400)).await;

        let page = browser
            .new_page("about:blank")
            .await
            .map_err(|e| BrowserScrapeError::Protocol(e.to_string()))?;

        navigate_page(&page, url, &options).await?;

        let mut content = extract_page_content(&page, url).await?;

        // One in-session reload for transient Chrome network error pages.
        if is_browser_error_page(&content) {
            tokio::time::sleep(Duration::from_millis(500)).await;
            navigate_page(&page, url, &options).await?;
            content = extract_page_content(&page, url).await?;
        }

        if options.capture_screenshot {
            content.screenshot_png = Some(capture_page_png(&page).await?);
        }

        Ok(content)
    }
    .await;

    let _ = browser.close().await;
    let _ = handler_task.await;
    drop(profile_dir);

    result
}

async fn navigate_page(
    page: &chromiumoxide::Page,
    url: &str,
    options: &ScrapeOptions,
) -> Result<(), BrowserScrapeError> {
    // Avoid chromiumoxide `Page::goto` / `Page.navigate`: that path hardcodes a
    // 30s navigation-lifecycle timeout (FrameNavigationRequest), which heavy SPAs
    // behind local proxies routinely exceed even when Chrome eventually loads the page.
    // Drive navigation via JS and poll readiness with our own deadline instead.
    let assign = format!(
        "window.location.assign({})",
        serde_json::to_string(url).unwrap_or_else(|_| format!("\"{url}\""))
    );
    page.evaluate(assign.as_str())
        .await
        .map_err(|e| BrowserScrapeError::Navigation {
            url: url.to_string(),
            message: format!("location.assign failed: {e}"),
        })?;

    // Give the browser a moment to start the navigation before polling.
    tokio::time::sleep(Duration::from_millis(300)).await;

    wait_for_document_ready(page, options.navigation_timeout).await?;

    if let Some(selector) = &options.ready_selector {
        wait_for_selector(page, selector, options.navigation_timeout).await?;
    } else {
        wait_for_meaningful_content(page, options.navigation_timeout).await?;
    }

    if options.settle_ms > 0 {
        tokio::time::sleep(Duration::from_millis(options.settle_ms)).await;
    }

    Ok(())
}

/// Full unattended check-and-scrape: browser navigate/wait + structured extract.
///
/// Retries on transient launch/navigation failures or Chrome error pages
/// (e.g. `ERR_NETWORK_CHANGED` behind local proxies).
pub async fn check_and_scrape(
    url: &str,
    options: ScrapeOptions,
) -> Result<ScrapeResult, BrowserScrapeError> {
    const MAX_ATTEMPTS: u32 = 3;
    let mut last_err = None;
    for attempt in 1..=MAX_ATTEMPTS {
        match navigate_and_extract(url, options.clone()).await {
            Ok(content) => {
                if is_browser_error_page(&content) && attempt < MAX_ATTEMPTS {
                    last_err = Some(BrowserScrapeError::Navigation {
                        url: url.to_string(),
                        message: format!(
                            "browser error page (attempt {attempt}): {}",
                            content.text.chars().take(120).collect::<String>()
                        ),
                    });
                    tokio::time::sleep(Duration::from_millis(1_000 * u64::from(attempt))).await;
                    continue;
                }
                return Ok(extract_markets(&content));
            }
            Err(e) => {
                last_err = Some(e);
                if attempt < MAX_ATTEMPTS {
                    tokio::time::sleep(Duration::from_millis(1_000 * u64::from(attempt))).await;
                }
            }
        }
    }
    Err(last_err.expect("retry loop always sets last_err"))
}

fn is_browser_error_page(content: &PageContent) -> bool {
    let t = content.text.to_ascii_lowercase();
    (t.contains("this page") && t.contains("couldn") && t.contains("load"))
        || t.contains("err_connection")
        || t.contains("err_name_not_resolved")
        || t.contains("err_timed_out")
        || (content.title.is_empty()
            && t.contains("reload")
            && t.contains("back")
            && content.text.len() < 200)
}

async fn wait_for_document_ready(
    page: &chromiumoxide::Page,
    timeout: Duration,
) -> Result<(), BrowserScrapeError> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        match evaluate_string(page, "document.readyState").await {
            Ok(state) if state == "complete" || state == "interactive" => return Ok(()),
            Ok(state) => {
                if tokio::time::Instant::now() >= deadline {
                    return Err(BrowserScrapeError::ReadyTimeout(format!(
                        "document.readyState stuck at {state}"
                    )));
                }
            }
            Err(e) if is_transient_context_error(&e) => {
                // Context is torn down mid-navigation; keep polling.
                if tokio::time::Instant::now() >= deadline {
                    return Err(BrowserScrapeError::ReadyTimeout(format!(
                        "document never became ready: {e}"
                    )));
                }
            }
            Err(e) => {
                if tokio::time::Instant::now() >= deadline {
                    return Err(BrowserScrapeError::Protocol(e));
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

fn is_transient_context_error(message: &str) -> bool {
    let m = message.to_ascii_lowercase();
    m.contains("cannot find context")
        || m.contains("execution context was destroyed")
        || m.contains("inspected target navigated or closed")
        || m.contains("session with given id not found")
        || m.contains("target closed")
        || m.contains("most likely the page has been closed")
}

async fn evaluate_string(page: &chromiumoxide::Page, expression: &str) -> Result<String, String> {
    let result = tokio::time::timeout(Duration::from_secs(8), page.evaluate(expression))
        .await
        .map_err(|_| "evaluate timed out".to_string())?
        .map_err(|e| e.to_string())?;
    result.into_value::<String>().map_err(|e| e.to_string())
}

async fn evaluate_usize(page: &chromiumoxide::Page, expression: &str) -> Result<usize, String> {
    let result = tokio::time::timeout(Duration::from_secs(8), page.evaluate(expression))
        .await
        .map_err(|_| "evaluate timed out".to_string())?
        .map_err(|e| e.to_string())?;
    result.into_value::<usize>().map_err(|e| e.to_string())
}

async fn wait_for_selector(
    page: &chromiumoxide::Page,
    selector: &str,
    timeout: Duration,
) -> Result<(), BrowserScrapeError> {
    let deadline = tokio::time::Instant::now() + timeout;
    let expr = format!(
        "!!document.querySelector({})",
        serde_json::to_string(selector).unwrap_or_else(|_| "null".into())
    );
    loop {
        match evaluate_string(page, &format!("String({expr})")).await {
            Ok(v) if v == "true" => return Ok(()),
            Ok(_) | Err(_) => {
                if tokio::time::Instant::now() >= deadline {
                    return Err(BrowserScrapeError::ReadyTimeout(format!(
                        "selector not found: {selector}"
                    )));
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

async fn wait_for_meaningful_content(
    page: &chromiumoxide::Page,
    timeout: Duration,
) -> Result<(), BrowserScrapeError> {
    let deadline = tokio::time::Instant::now() + timeout;
    let mut last_len = 0usize;
    let mut stable_ticks = 0u32;
    loop {
        let len = match evaluate_usize(
            page,
            "() => (document.body && document.body.innerText) ? document.body.innerText.trim().length : 0",
        )
        .await
        {
            Ok(n) => n,
            Err(e) if is_transient_context_error(&e) => 0,
            Err(_) => 0,
        };

        // Non-trivial body text. Stability is best-effort: live SPAs may keep growing.
        if len >= 80 {
            if len == last_len {
                stable_ticks += 1;
                if stable_ticks >= 2 {
                    return Ok(());
                }
            } else {
                stable_ticks = 0;
                last_len = len;
            }
            if len >= 500 && stable_ticks >= 1 {
                return Ok(());
            }
            if len >= 2_000 {
                return Ok(());
            }
        }

        if tokio::time::Instant::now() >= deadline {
            if len > 0 {
                return Ok(());
            }
            return Err(BrowserScrapeError::ReadyTimeout(
                "page body never became non-empty (check proxy reachability and timeout)".into(),
            ));
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

async fn extract_page_content(
    page: &chromiumoxide::Page,
    url: &str,
) -> Result<PageContent, BrowserScrapeError> {
    // Pull DOM text, HTML, title, and any in-page JSON (Next.js, embedded market arrays).
    // Retry a few times: SPA navigations can invalidate the JS world briefly.
    let mut last_err = String::new();
    let payload: serde_json::Value = {
        let mut out = None;
        for attempt in 1..=5 {
            match tokio::time::timeout(
                Duration::from_secs(20),
                page.evaluate(
                    r#"() => {
                const text = document.body ? (document.body.innerText || '') : '';
                const html = document.documentElement
                    ? document.documentElement.outerHTML
                    : '';
                const title = document.title || '';
                const pageUrl = location.href || '';
                const json_blobs = [];

                const next = document.getElementById('__NEXT_DATA__');
                if (next && next.textContent) {
                    json_blobs.push(next.textContent);
                }

                document.querySelectorAll('script[type="application/json"], script[type="application/ld+json"]').forEach((el) => {
                    if (el.textContent && el.textContent.length > 20 && el.textContent.length < 2_000_000) {
                        json_blobs.push(el.textContent);
                    }
                });

                const cards = [];
                document.querySelectorAll(
                    '[data-market-id], [class*="market-card"], [class*="MarketCard"], article, [data-testid*="market"]'
                ).forEach((el) => {
                    const t = (el.innerText || '').trim();
                    if (t.length > 10 && t.length < 2000) cards.push(t);
                });

                return {
                    text: text.slice(0, 500000),
                    html: html.slice(0, 800000),
                    title,
                    url: pageUrl,
                    json_blobs: json_blobs.slice(0, 20),
                    cards: cards.slice(0, 100),
                };
            }"#,
                ),
            )
            .await
            {
                Ok(Ok(result)) => match result.into_value::<serde_json::Value>() {
                    Ok(v) => {
                        out = Some(v);
                        break;
                    }
                    Err(e) => last_err = e.to_string(),
                },
                Ok(Err(e)) => {
                    last_err = e.to_string();
                    if !is_transient_context_error(&last_err) && attempt >= 2 {
                        break;
                    }
                }
                Err(_) => last_err = "extract evaluate timed out".into(),
            }
            tokio::time::sleep(Duration::from_millis(400 * attempt as u64)).await;
        }
        out.ok_or(BrowserScrapeError::Extract(last_err))?
    };

    let mut text = payload
        .get("text")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    // Append card text blocks so parse can treat each card as a market unit.
    if let Some(cards) = payload.get("cards").and_then(|v| v.as_array()) {
        for card in cards {
            if let Some(c) = card.as_str() {
                if !text.contains(c) {
                    text.push_str("\n\n");
                    text.push_str(c);
                }
            }
        }
    }

    let json_blobs = payload
        .get("json_blobs")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();

    Ok(PageContent {
        url: payload
            .get("url")
            .and_then(|v| v.as_str())
            .unwrap_or(url)
            .to_string(),
        title: payload
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        text,
        html: payload
            .get("html")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        json_blobs,
        screenshot_png: None,
    })
}

/// Capture a viewport PNG via CDP. Retries on transient context/protocol errors.
async fn capture_page_png(page: &chromiumoxide::Page) -> Result<Vec<u8>, BrowserScrapeError> {
    let mut last_err = String::new();
    for attempt in 1..=5 {
        let params = ScreenshotParams::builder()
            .format(CaptureScreenshotFormat::Png)
            .build();
        match tokio::time::timeout(Duration::from_secs(20), page.screenshot(params)).await {
            Ok(Ok(bytes)) if bytes.starts_with(super::parse::PNG_SIGNATURE) && bytes.len() > 64 => {
                return Ok(bytes);
            }
            Ok(Ok(bytes)) => {
                last_err = format!(
                    "screenshot returned non-PNG or tiny payload ({} bytes)",
                    bytes.len()
                );
            }
            Ok(Err(e)) => {
                last_err = e.to_string();
                if !is_transient_context_error(&last_err) && attempt >= 2 {
                    break;
                }
            }
            Err(_) => last_err = "screenshot timed out".into(),
        }
        tokio::time::sleep(Duration::from_millis(400 * attempt as u64)).await;
    }
    Err(BrowserScrapeError::Extract(format!(
        "failed to capture page screenshot: {last_err}"
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn find_chrome_returns_existing_binary_or_clear_error() {
        match find_chrome_executable(None) {
            Ok(path) => {
                assert!(
                    path.is_file(),
                    "resolved path is not a file: {}",
                    path.display()
                );
            }
            Err(BrowserScrapeError::ChromeNotFound(_)) => {
                // Acceptable in environments without Chrome; error type is correct.
            }
            Err(other) => panic!("unexpected error variant: {other}"),
        }
    }

    #[test]
    fn explicit_bad_chrome_path_errors() {
        let bad = PathBuf::from("/nonexistent/chrome-binary-xyz");
        let err = find_chrome_executable(Some(&bad)).unwrap_err();
        assert!(matches!(err, BrowserScrapeError::ChromeNotFound(_)));
    }

    #[test]
    fn default_options_do_not_capture_screenshot() {
        let opts = ScrapeOptions::default();
        assert!(!opts.capture_screenshot);
    }
}
