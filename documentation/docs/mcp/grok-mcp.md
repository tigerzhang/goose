---
title: Grok Build Extension
description: Call the Grok Build CLI from goose without changing your LLM provider
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';
import GooseBuiltinInstaller from '@site/src/components/GooseBuiltinInstaller';

The Grok Build extension lets goose send prompts to the local [`grok`](https://x.ai/build) CLI (Grok Build), then inspect those Grok sessions. goose stays on whatever provider you already configured. Grok Build does the delegated work.

## Prerequisites

1. Install Grok Build:

   ```bash
   curl -fsSL https://x.ai/cli/install.sh | bash
   ```

2. Authenticate:

   ```bash
   grok login
   ```

   Or set `XAI_API_KEY`. If `grok` is not on your PATH, set `GROK_COMMAND` to the binary.

## Configuration

<Tabs groupId="interface">
  <TabItem value="ui" label="goose Desktop" default>
  <GooseBuiltinInstaller
    extensionName="Grok Build"
    description="Call the Grok Build CLI to run prompts and inspect Grok sessions"
    extensionId="grok"
  />
  </TabItem>
  <TabItem value="cli" label="goose CLI">

  1. Run the `configure` command:
  ```sh
  goose configure
  ```

  2. Choose `Toggle Extensions` and enable `grok`.

  Or start a session with the extension for this run only:

  ```sh
  goose session --with-builtin grok
  ```

  </TabItem>
</Tabs>

Use a longer timeout for large jobs (Desktop defaults to 600 seconds). In a recipe or config:

```yaml
extensions:
  - type: builtin
    name: grok
    timeout: 600
```

## Tool Reference

| Tool | What it does |
|------|--------------|
| `grok_run(prompt, cwd?, session_id?, continue_last?, model?, max_turns?)` | Run `grok -p` and return the result plus a Grok `session_id` |
| `grok_sessions(query?, limit?)` | List recent Grok sessions, or search titles and prompts |
| `grok_status(session_id)` | Read summary, model, timestamps, and usage for a Grok session |

`grok_run` always passes `--always-approve` so Grok can finish without a TTY. Sessions are stored under `~/.grok/sessions/`.

## Example

```text
Use Grok Build to review crates/goose/src/providers for ACP wiring.
Then show me the Grok session id and status.
```

goose should call `grok_run`, then `grok_status` with the returned `session_id`. To continue that same Grok conversation:

```text
Resume that Grok session and ask it to list the remaining follow-ups.
```
