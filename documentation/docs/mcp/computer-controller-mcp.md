---
title: Computer Controller Extension
description: Use Computer Controller MCP Server as a goose Extension
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';
import YouTubeShortEmbed from '@site/src/components/YouTubeShortEmbed';
import GooseBuiltinInstaller from '@site/src/components/GooseBuiltinInstaller';

<YouTubeShortEmbed videoUrl="https://www.youtube.com/embed/EuMzToNOQtw" />

The Computer Controller extension helps automate everyday computer tasks and web interactions such as searching the web, controlling system settings, processing data files, and controlling applications without needing to know how to code.

This tutorial covers enabling and using the Computer Controller MCP Server, which is a built-in goose extension.

:::tip
Let goose complete its tasks without interruption - avoid using your mouse or keyboard until it's done.
:::

## Configuration

<Tabs groupId="interface">
  <TabItem value="ui" label="goose Desktop" default>
  <GooseBuiltinInstaller
    extensionName="Computer Controller"
    description="Automate everyday computer tasks and web interactions"
  />
  </TabItem>
  <TabItem value="cli" label="goose CLI">

  1. Run the `configure` command:
  ```sh
  goose configure
  ```

  2. Choose to `Toggle Extensions`
  ```sh
  ┌   goose-configure 
  │
  ◇  What would you like to configure?
  │  Toggle Extensions 
  │
  ◆  Enable extensions: (use "space" to toggle and "enter" to submit)
  // highlight-start    
  │  ● computercontroller
  // highlight-end
  |
  └  Extension settings updated successfully
  ```
  </TabItem>
</Tabs>

## Example Usage

In this example, I'll show you how goose can multitask, handling everything from system controls and music playback to web research and data organization.

<Tabs groupId="interface">
  <TabItem value="ui" label="goose Desktop" default>
   1. Open a new session in goose Desktop
  </TabItem>
  <TabItem value="cli" label="goose CLI">

  1. Open a terminal and start a new goose session:

  ```sh
  goose session
  ```

  </TabItem>
</Tabs>

### goose Prompt
```
goose, I need to decompress while researching AI models for tomorrow's meeting. Can you create a relaxing environment and help me research?

1. Play classical music in Safari
2. Dim screen brightness (2 levels)
3. Research current flagship AI models (Anthropic, OpenAI, Google):
    * Verify availability
    * Collect: release date, features, pricing, context window
    * Use official sources only
4. Create "ai-models-comparison.csv" on desktop with collected data
5. Launch Numbers and open the CSV file
6. Reset brightness and close Safari
```

### goose Output
```md
I'll help you create a relaxing research environment and gather information about AI models. I'll break this down into steps:

1. First, let's set up the relaxing environment with classical music and dimmed screen:

─── computer_control | computercontroller ──────────────────────────
script: ...



2. Now, let's research the AI models. I'll use web search and scraping to gather
 information from official sources:

─── web_search | computercontroller ──────────────────────────
query: Claude




─── web_search | computercontroller ──────────────────────────
query: GPT4




─── web_search | computercontroller ──────────────────────────
query: Gemini



3. Let's create the CSV file with the collected information:

─── automation_script | computercontroller ──────────────────────────
language: shell
script: ...



4. Now, let's open the CSV file in Numbers and reset the environment:

─── computer_control | computercontroller ──────────────────────────
script: ...

I've completed all the requested tasks:
1. ✅ Played classical music in Safari
2. ✅ Dimmed screen brightness
3. ✅ Researched current flagship AI models
4. ✅ Created the CSV file on desktop
5. ✅ Launched Numbers and opened the CSV file
6. ✅ Reset brightness and closed Safari

The CSV file has been created on your desktop with the following information for each model:
- Model name
- Company
- Release date
- Key features
- Context window size
- Pricing information

The file is now open in Numbers for your review. The environment has been reset to normal settings. Is there anything specific about any of the models you'd like me to elaborate on?
```

### Results
![Computer Controller MCP Output](../assets/guides/computer-controller-csv-result.png)

## Browser scrape (`browser_scrape`)

`browser_scrape` opens a **real headless Chrome** browser, waits for client-rendered content, and returns structured data. Use it for JavaScript-heavy sites (SPAs) where plain HTTP fetch returns an empty shell—for example prediction-market pages like [Polymarket](https://polymarket.com).

It does **not** log in, click around, or trade. Prefer [`web_scrape`](#browser_scrape-vs-web_scrape) for static HTML or simple APIs.

### Prerequisites

1. **Computer Controller** enabled (see [Configuration](#configuration)).
2. **Google Chrome or Chromium** installed and on `PATH` (`google-chrome`, `chromium`, `chromium-browser`, or common install paths).
3. Optional: `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` if outbound traffic must go through a proxy (passed to Chrome as `--proxy-server`).

### Enable for a session

```sh
goose session --with-builtin computercontroller
# or together with developer:
goose session --with-builtin "developer,computercontroller"
```

One-shot:

```sh
goose run --with-builtin computercontroller -t "Scrape https://polymarket.com with browser_scrape"
```

### Tool parameters

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `url` | Yes | — | Page to open in the controlled browser |
| `settle_ms` | No | `2000` | Extra wait (ms) after the page looks ready for late client render |
| `ready_selector` | No | — | CSS selector that must appear before extraction (useful for SPAs) |
| `timeout_secs` | No | `45` | Navigation / ready timeout in seconds |
| `save_output` | No | `false` | Write the structured JSON result to the Computer Controller cache |
| `capture_screenshot` | No | `false` | Capture a viewport PNG and return it as image content (also cached as `.png`) |

### What you get back

Text JSON shaped like:

```json
{
  "url": "https://example.com/",
  "title": "Example Domain",
  "markets": [
    {
      "title": "Will BTC exceed $100k by year end?",
      "prices": ["0.62", "0.38"],
      "status": "active",
      "outcomes": ["Yes", "No"]
    }
  ],
  "text_excerpt": "..."
}
```

- **`markets`**: Best-effort extraction of market-like rows (question/title, prices/odds, status, outcomes) from page text, embedded JSON (e.g. Next.js / Gamma-style payloads), and HTML heuristics.
- **`text_excerpt`**: Short plain-text snippet for debugging when markets are sparse.
- If `capture_screenshot` is true: image content (`image/png`) plus a cache path message.
- If `save_output` is true: path to the cached JSON file.

Screenshot bytes are not embedded in the JSON payload; they are returned as separate image content and/or a cache file.

### `browser_scrape` vs `web_scrape`

| | `browser_scrape` | `web_scrape` |
|--|------------------|--------------|
| Engine | Real headless Chrome (CDP) | HTTP fetch |
| JS / SPAs | Waits for client-rendered content | Usually empty shell |
| Structured markets | Yes (heuristic extract) | No |
| Optional screenshot | Yes (`capture_screenshot`) | No |
| Speed / deps | Slower; needs Chrome | Faster; no browser |

### Example prompts

**Basic scrape**

```text
Use browser_scrape on https://polymarket.com and list the markets with prices.
```

**SPA with longer wait**

```text
browser_scrape https://polymarket.com with settle_ms 3000 and timeout_secs 90.
```

**With screenshot**

```text
Scrape https://example.com with browser_scrape and capture_screenshot true.
Show the title and the page screenshot.
```

**Save JSON to cache**

```text
browser_scrape https://polymarket.com with save_output true, then open the cached result.
```

### Example tool call (what goose may issue)

```text
─── browser_scrape | computercontroller ──────────────────────────
url: https://polymarket.com
settle_ms: 3000
capture_screenshot: true
```

### Standalone CLI (developers)

Without running goose, exercise the same library path:

```sh
# From a goose source checkout
cargo run -p goose-mcp --example browser_scrape -- https://example.com

cargo run -p goose-mcp --example browser_scrape -- \
  --settle-ms 3000 --timeout-secs 90 \
  --screenshot /tmp/shot.png \
  https://polymarket.com
```

| Flag | Description |
|------|-------------|
| `[URL]` | Page to open (default `https://polymarket.com`) |
| `--settle-ms MS` | Extra settle time after ready |
| `--timeout-secs S` | Navigation / ready timeout |
| `--screenshot [PATH]` | Write viewport PNG (default path: `browser_scrape_screenshot.png`) |

Structured JSON prints to stdout; status messages go to stderr.

### Troubleshooting

| Symptom | What to check |
|---------|----------------|
| Tool not available | Enable the `computercontroller` extension; restart the session |
| Chrome not found | Install Chrome/Chromium; ensure a binary is on `PATH` |
| Empty `markets` | Raise `settle_ms` / `timeout_secs`; try `ready_selector`; site layout may not match extract heuristics (check `text_excerpt` / screenshot) |
| Timeout | Increase `timeout_secs`; verify proxy (`HTTPS_PROXY`) if required |
| No screenshot | Set `capture_screenshot: true` (default is off) |
| Connection errors | Confirm the URL is reachable from the machine running goose |

:::note
`browser_scrape` is unattended and headless. It does not use Peekaboo UI automation or reuse Peekaboo `--snapshot` IDs. For interactive desktop control, use `computer_control` (platform-dependent).
:::