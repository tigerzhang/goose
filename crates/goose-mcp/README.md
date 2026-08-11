### Test with MCP Inspector

Update examples/mcp.rs to use the appropriate MCP server (eg. DeveloperRouter)

```bash
npx @modelcontextprotocol/inspector cargo run -p goose-mcp --example mcp
```

Then visit the Inspector in the browser window and test the different endpoints.

### `browser_scrape` (Computer Controller)

JS-capable scrape via headless Chrome (markets/odds extract + optional viewport PNG).

- **In goose:** enable the `computercontroller` extension; tool name `browser_scrape`.
- **User docs:** [Computer Controller — Browser scrape](../../documentation/docs/mcp/computer-controller-mcp.md#browser-scrape-browser_scrape)
- **Standalone:**
  ```bash
  cargo run -p goose-mcp --example browser_scrape -- --screenshot out.png https://example.com
  ```
- **Requires:** Chrome/Chromium on `PATH`.

### Polymarket (API + browser)

Built-in extension for Polymarket discovery, books, analysis context, and paper/live order intents.

- **In goose:** `goose session --with-builtin polymarket`
- **MCP process:** `goose mcp polymarket`
- **User docs:** [Polymarket MCP](../../documentation/docs/mcp/polymarket-mcp.md)
- **Code:** `src/polymarket/`
- **Browser path** reuses the same headless Chrome stack as `browser_scrape` (Chrome/Chromium on `PATH`).
- **Live orders** require `POLYMARKET_ENABLE_LIVE_ORDERS=1`, `confirm_live`, and a pre-signed order from Polymarket’s official SDK.
