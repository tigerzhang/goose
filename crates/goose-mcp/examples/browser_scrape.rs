//! Unattended browser check-and-scrape CLI.
//!
//! Usage:
//!   cargo run -p goose-mcp --example browser_scrape -- https://polymarket.com
//!   cargo run -p goose-mcp --example browser_scrape -- --settle-ms 3000 https://polymarket.com
//!   cargo run -p goose-mcp --example browser_scrape -- --screenshot out.png https://example.com

use goose_mcp::computercontroller::{check_and_scrape, is_valid_png, ScrapeOptions};
use std::env;
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Duration;

#[tokio::main]
async fn main() -> ExitCode {
    let mut settle_ms = 2_500u64;
    let mut timeout_secs = 90u64;
    let mut capture_screenshot = false;
    let mut screenshot_path: Option<PathBuf> = None;
    let mut url = String::from("https://polymarket.com");
    let mut args = env::args().skip(1).peekable();

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--settle-ms" => {
                if let Some(v) = args.next() {
                    settle_ms = v.parse().unwrap_or(settle_ms);
                }
            }
            "--timeout-secs" => {
                if let Some(v) = args.next() {
                    timeout_secs = v.parse().unwrap_or(timeout_secs);
                }
            }
            "--screenshot" => {
                capture_screenshot = true;
                // Optional path: next arg if present and not a flag.
                if let Some(next) = args.peek() {
                    if !next.starts_with('-') {
                        screenshot_path = Some(PathBuf::from(args.next().unwrap()));
                    }
                }
                if screenshot_path.is_none() {
                    screenshot_path = Some(PathBuf::from("browser_scrape_screenshot.png"));
                }
            }
            "-h" | "--help" => {
                eprintln!(
                    "Usage: browser_scrape [--settle-ms MS] [--timeout-secs S] [--screenshot [PATH]] [URL]\n\
                     Default URL: https://polymarket.com\n\
                     --screenshot [PATH]  Capture viewport PNG (default path: browser_scrape_screenshot.png)"
                );
                return ExitCode::SUCCESS;
            }
            other if other.starts_with('-') => {
                eprintln!("Unknown flag: {other}");
                return ExitCode::from(2);
            }
            other => {
                url = other.to_string();
            }
        }
    }

    let options = ScrapeOptions {
        settle_ms,
        navigation_timeout: Duration::from_secs(timeout_secs),
        no_sandbox: true,
        capture_screenshot,
        ..Default::default()
    };

    eprintln!(
        "browser_scrape: navigating to {url} (settle_ms={settle_ms}, screenshot={capture_screenshot})"
    );
    match check_and_scrape(&url, options).await {
        Ok(result) => {
            if let Some(path) = screenshot_path.as_ref() {
                match result.screenshot_png.as_ref() {
                    Some(png) => {
                        if let Err(e) = std::fs::write(path, png) {
                            eprintln!("failed to write screenshot to {}: {e}", path.display());
                            return ExitCode::FAILURE;
                        }
                        if is_valid_png(png) {
                            eprintln!(
                                "screenshot: wrote {} bytes to {} (valid PNG)",
                                png.len(),
                                path.display()
                            );
                        } else {
                            eprintln!(
                                "screenshot: wrote {} bytes to {} (warning: not a valid PNG signature/size)",
                                png.len(),
                                path.display()
                            );
                        }
                    }
                    None => {
                        eprintln!(
                            "screenshot requested but no PNG bytes returned (path would be {})",
                            path.display()
                        );
                        return ExitCode::FAILURE;
                    }
                }
            }

            match serde_json::to_string_pretty(&result) {
                Ok(json) => {
                    println!("{json}");
                    if result.markets.is_empty() {
                        eprintln!(
                            "warning: 0 markets extracted (title={:?}, excerpt_len={})",
                            result.title,
                            result.text_excerpt.len()
                        );
                    } else {
                        eprintln!("ok: {} market(s) extracted", result.markets.len());
                    }
                    ExitCode::SUCCESS
                }
                Err(e) => {
                    eprintln!("serialize error: {e}");
                    ExitCode::FAILURE
                }
            }
        }
        Err(e) => {
            eprintln!("browser_scrape error: {e}");
            ExitCode::FAILURE
        }
    }
}
