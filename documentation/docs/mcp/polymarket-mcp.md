---
title: Polymarket Extension
description: Discover Polymarket markets via API and browser; analysis context and order intents
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';
import GooseBuiltinInstaller from '@site/src/components/GooseBuiltinInstaller';

The Polymarket extension gives goose tools to **discover markets**, **inspect order books**, **scrape the live site in a browser**, **package analysis context for an LLM**, and **build paper (or carefully gated live) order intents**.

It is a **built-in** goose extension (no separate install).

## Configuration

<Tabs groupId="interface">
  <TabItem value="ui" label="goose Desktop" default>
  <GooseBuiltinInstaller
    extensionName="Polymarket"
    description="Polymarket markets via API and browser; analysis context and paper/live order intents"
    extensionId="polymarket"
  />
  </TabItem>
  <TabItem value="cli" label="goose CLI">

  Enable for one session:

  ```sh
  goose session --with-builtin polymarket
  ```

  Or permanently via configure:

  ```sh
  goose configure
  # Toggle Extensions → enable polymarket
  ```

  Standalone MCP process (e.g. MCP Inspector):

  ```sh
  goose mcp polymarket
  ```

  </TabItem>
</Tabs>

## Two data paths

| Path | Tools | Best for |
|------|--------|----------|
| **API** | `list_markets`, `list_events`, `get_market`, `search`, `get_order_book`, `get_price`, `get_positions` | Token IDs, books, prices, automation |
| **Browser** | `browser_scrape_markets` | What the JS SPA shows; screenshots; narrative UI |

Prefer **API** for trading decisions. Use **browser** when you need page text/layout or to cross-check the site. Chrome/Chromium must be on `PATH` for browser tools.

## Typical agent workflow

1. `list_markets` or `search` — find liquid markets  
2. `get_market` + `get_order_book` / `get_price` — structure and depth  
3. Optional: `browser_scrape_markets` on `https://polymarket.com` or an event URL  
4. `prepare_analysis_context` — market + books + scoring hints for the LLM  
5. LLM estimates `fair_prob` (calibrated probability)  
6. `build_order_intent` with `fair_prob` — risk-checked paper intent  
7. `place_order` with `dry_run: true` (default) for paper; live only with gates below  

## Tool reference

| Tool | Description |
|------|-------------|
| `list_markets` | Gamma API market list (normalized summaries) |
| `list_events` | Gamma API events |
| `get_market` | One market by id or slug |
| `search` | Public search (events / tags / profiles) |
| `get_order_book` | CLOB book for a `token_id` |
| `get_price` | CLOB price (+ midpoint) |
| `get_positions` | Data API positions for a wallet |
| `browser_scrape_markets` | Headless Chrome scrape → market titles/prices |
| `prepare_analysis_context` | Market + YES/NO books + analysis hints |
| `build_order_intent` | Risk-checked limit intent (always paper) |
| `place_order` | Paper log by default; live needs signed order + env |

## Orders and safety

- **`dry_run` defaults to `true`.** Paper intents never hit the exchange.  
- **Live** requires all of:
  - `confirm_live: true`
  - `POLYMARKET_ENABLE_LIVE_ORDERS=1`
  - `signed_order` JSON produced by Polymarket’s official SDK ([py-clob-client](https://github.com/Polymarket/py-clob-client) / TypeScript client) after EIP-712 signing  
- Optional L2 headers for authenticated post: `POLYMARKET_API_KEY`, `POLYMARKET_API_SECRET`, `POLYMARKET_API_PASSPHRASE`  
- Risk checks: max notional (default $25), min edge when `fair_prob` is set, price bounds  
- This extension **does not store private keys** and **does not sign** orders in-process  

:::warning Financial and legal risk
Prediction-market trading can lose money. You are responsible for jurisdiction, Polymarket Terms of Service, and any automation you run. Start with paper (`dry_run`) only.
:::

## Example prompts

> Enable Polymarket and list the top 10 markets by 24h volume, then for the first one prepare analysis context and summarize the book.

> Scrape https://polymarket.com with the browser tool and compare three titles to API `search` results.

> Build a paper buy order for token … at 0.35 size 5 with fair_prob 0.50.

## Related

- Official docs: [docs.polymarket.com](https://docs.polymarket.com/)  
- Computer Controller `browser_scrape` (generic JS scrape): [Computer Controller](/docs/mcp/computer-controller-mcp)
