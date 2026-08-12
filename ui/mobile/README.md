# goose Mobile (Remote PWA)

Thin phone client for a **remote** `goose serve` agent over ACP HTTP.

This is the P1 spike from `REMOTE_MOBILE_GOOSE_DESIGN.md`: the phone is only a UI. LLM calls, shell, files, and MCP tools all run on the remote host.

## Features (v1)

- Connect: base URL, secret key, optional cert fingerprint (stored; browsers cannot pin), host cwd
- Probe `/status` then authenticated `/acp`
- New ACP session → chat → streaming assistant text
- Splash slash commands on empty chat (`/help`, `/status`, `/compact`, `/skills`, `/clear`, `/exit`)
- Type `/` for command suggestions; agent commands run on the remote host
- Collapsed tool-call activity
- Tool permission modal (allow once / always / deny)
- Installable PWA shell (home-screen)

## Prerequisites

1. Remote host running authenticated `goose serve` (TLS recommended):

   ```bash
   GOOSE_SERVER__SECRET_KEY='a-long-random-secret' \
     goose serve --platform desktop --host 0.0.0.0 --port 3000 --tls \
     --allowed-origin 'http://localhost:5173' \
     --allowed-origin 'https://YOUR_DEPLOYED_PWA_ORIGIN'
   ```

   When you pass `--allowed-origin`, it **replaces** the default loopback CORS allowlist — include every origin you need.

2. Phone/browser can reach the host (LAN or Tailscale/VPN recommended).

## Develop

From the monorepo `ui/` workspace:

```bash
# once: install workspace deps (from ui/)
pnpm install

# build SDK so local changes to createHttpStream auth are available
pnpm --filter @aaif/goose-sdk run build:ts

# start PWA dev server
pnpm --filter @aaif/goose-mobile dev
```

Open the printed URL on your phone (same network/VPN), or use desktop browser first.

## Connect fields

| Field | Meaning |
|-------|---------|
| Server base URL | e.g. `https://100.x.x.x:3000` — not `/acp` |
| Secret key | Same as `GOOSE_SERVER__SECRET_KEY` |
| Host working directory | Remote path for `session/new` cwd (default `.`) |
| Certificate fingerprint | Optional note/storage only in browser; true pinning needs native (P2) |

Settings are stored in `localStorage` (device-local; not multi-user auth).

## Auth

Uses `@aaif/goose-sdk` `createHttpStream` with `X-Secret-Key` on every ACP request.

## Non-goals (v1)

- Agent-on-phone / device automation (archived goose Mobile)
- Extension management UI, recipes, OAuth
- Native cert pinning / secure enclave secret storage

## Security reminders

- Tools execute as the host user. Approvals on the phone are security-critical.
- Do not expose `goose serve` on the public internet without TLS + strong secret + firewall/VPN.
- Never use `--dangerously-unauthenticated` on a network-reachable host with shell builtins.
