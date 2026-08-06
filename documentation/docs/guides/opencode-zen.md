---
title: OpenCode Zen
description: Use OpenCode Zen models with goose via the OpenAI-compatible API
---

# OpenCode Zen

[OpenCode Zen](https://opencode.ai/zen) is a curated gateway of models tested for coding agents. goose ships a first-class **OpenCode Zen** provider that talks to Zen’s OpenAI-compatible API.

| | |
|---|---|
| **Provider id** | `opencode` |
| **Display name** | OpenCode Zen |
| **API key env** | `OPENCODE_API_KEY` |
| **Base URL** | `https://opencode.ai/zen/v1` |
| **Docs** | [opencode.ai/docs/zen](https://opencode.ai/docs/zen) |

goose uses Zen’s chat-completions surface (`/v1/chat/completions`). Model lists are refreshed from `https://opencode.ai/zen/v1/models` when the API is reachable, with a bundled static list as fallback.

## Prerequisites

1. An [OpenCode Zen](https://opencode.ai/zen) account.
2. An API key from the Zen auth / account UI.
3. A goose build that includes the OpenCode Zen provider (this feature).

## Quick start (CLI)

### 1. Configure interactively

```sh
goose configure
```

1. Select **Configure Providers**.
2. Choose **OpenCode Zen** (filter with `opencode` or `zen` if the list is long).
3. Enter your `OPENCODE_API_KEY` when prompted.
4. Pick a model (for example `big-pickle` or `claude-sonnet-4-5`).

### 2. Or set environment variables

```sh
export OPENCODE_API_KEY="your-api-key"
export GOOSE_PROVIDER=opencode
export GOOSE_MODEL=big-pickle

goose session
```

### 3. One-off run with flags

```sh
export OPENCODE_API_KEY="your-api-key"

goose run --provider opencode --model big-pickle -t "Summarize this repo"
```

## Desktop

1. Open **Settings → Models → Configure providers**.
2. Select **OpenCode Zen**.
3. Paste `OPENCODE_API_KEY` and submit.
4. Use **Switch models** (or the model name in the footer) to choose a Zen model.

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENCODE_API_KEY` | Yes | Zen API key (secret). Same key family as OpenCode Go. |
| `GOOSE_PROVIDER` | For non-interactive use | Must be `opencode` for OpenCode Zen. |
| `GOOSE_MODEL` | Recommended | Zen model id (see below). |

You can also store the key through `goose configure` so you do not need to export it every session.

## Models

Zen exposes many models. goose keeps a curated static list and can fetch the live list from the API.

### Free / low-cost starters

| Model id | Notes |
|----------|--------|
| `big-pickle` | Free stealth coding default |
| `deepseek-v4-flash-free` | Free DeepSeek flash |
| `mimo-v2.5-free` | Free MiMo |
| `minimax-m3-free` | Free MiniMax |
| `nemotron-3-ultra-free` | Free Nemotron ultra |
| `north-mini-code-free` | Free North mini code |

### Common paid / premium ids

| Family | Example model ids |
|--------|-------------------|
| Claude | `claude-haiku-4-5`, `claude-sonnet-4-5`, `claude-sonnet-4-6`, `claude-opus-4-5`, `claude-opus-4-6` |
| OpenAI | `gpt-5.5`, `gpt-5.4`, `gpt-5.3-codex` |
| Gemini | `gemini-3.5-flash`, `gemini-3.1-pro` |
| Others | `kimi-k2.6`, `deepseek-v4-pro`, `deepseek-v4-flash`, `grok-4.5`, `glm-5.1`, `minimax-m2.7`, `qwen3.6-plus` |

**Important:** request model ids must match Zen’s API listing (dash-style Claude versions such as `claude-sonnet-4-5`, not dotted catalog-only names).

Live catalog:

```sh
curl -sS -H "Authorization: Bearer $OPENCODE_API_KEY" \
  https://opencode.ai/zen/v1/models | jq '.data[].id'
```

## OpenAI-compatible API usage (outside goose)

Zen is usable with any OpenAI-compatible client.

### Chat completion

```sh
curl -sS https://opencode.ai/zen/v1/chat/completions \
  -H "Authorization: Bearer $OPENCODE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "big-pickle",
    "messages": [{"role": "user", "content": "Hello from Zen"}]
  }'
```

### Python (OpenAI SDK)

```python
from openai import OpenAI

client = OpenAI(
    api_key="your-api-key",  # or os.environ["OPENCODE_API_KEY"]
    base_url="https://opencode.ai/zen/v1",
)

resp = client.chat.completions.create(
    model="big-pickle",
    messages=[{"role": "user", "content": "Hello from Zen"}],
)
print(resp.choices[0].message.content)
```

### Base URL notes

| Setting | Value |
|---------|--------|
| Root | `https://opencode.ai/zen/v1` |
| Chat | `https://opencode.ai/zen/v1/chat/completions` |
| Models | `https://opencode.ai/zen/v1/models` |

Auth is a standard Bearer token: `Authorization: Bearer <OPENCODE_API_KEY>`.

Zen also documents native endpoints for some families (`/responses`, Anthropic `/messages`, Google paths). goose’s bundled provider uses the OpenAI-compatible chat path only.

## OpenCode Zen vs OpenCode Go

| | OpenCode Zen | OpenCode Go |
|---|--------------|-------------|
| goose provider id | `opencode` | `opencode_go` |
| Display name | OpenCode Zen | OpenCode Go |
| Base URL | `https://opencode.ai/zen/v1` | `https://opencode.ai/zen/go/v1` |
| API key | `OPENCODE_API_KEY` | `OPENCODE_API_KEY` (same env) |
| Focus | Broad curated coding gateway (Claude, GPT, Gemini, free models, …) | Go-oriented model set (Kimi, GLM, Qwen, …) |

Both can use the same key; pick the provider that matches the models you want.

## Verify setup

```sh
# Key present and provider selected
export OPENCODE_API_KEY="your-api-key"
export GOOSE_PROVIDER=opencode
export GOOSE_MODEL=big-pickle

goose doctor
goose run --provider opencode --model big-pickle -t "Reply with the word pong only"
```

If configuration fails:

1. Confirm the key is valid at [opencode.ai](https://opencode.ai/zen).
2. Confirm provider id is `opencode` (not `opencode_go` unless you want Go).
3. Confirm model id exists in `/zen/v1/models`.
4. Use a goose binary that includes the OpenCode Zen provider.

## Pricing and limits

Zen is pay-as-you-go for most models; some free models are available. Pricing and availability change over time—see [OpenCode Zen docs](https://opencode.ai/docs/zen) and your account dashboard.

## Related

- [Configure LLM providers](/docs/getting-started/providers)
- [Environment variables](/docs/guides/environment-variables)
- [OpenCode Zen documentation](https://opencode.ai/docs/zen)
- [OpenCode Zen product page](https://opencode.ai/zen)
