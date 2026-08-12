# Design: Remote goose Agent + Mobile Phone Client

**Status:** Implementation started (P1 mobile PWA spike).  
**Anchors:** `goose serve` ACP HTTP/WebSocket, existing Desktop external-backend path, `@aaif/goose-sdk` / CUSTOM_DISTROS custom-UI guidance.  
**Code:** `ui/mobile` (PWA), `ui/sdk` `createHttpStream({ secretKey })` for `X-Secret-Key` auth.

---

## 1. Role split: remote agent vs thin phone client

### Principle

goose’s architecture already separates **interface**, **agent**, and **extensions**:

| Role | Where it runs | Responsibility |
|------|----------------|----------------|
| **Agent** | Remote computer | Interactive loop, LLM provider calls, tool execution via extensions/MCP |
| **Extensions / tools** | Remote computer | Shell, files, browser, MCP servers — always in the host’s environment |
| **Interface (client)** | Phone (and optionally Desktop/CLI) | Collect user input, stream agent events, surface permissions/approvals |

The remote host runs the long-lived agent process. The phone is a **thin client**: it does **not** run tools against phone storage or a phone shell.

### Recommended process on the remote host

```bash
GOOSE_SERVER__SECRET_KEY='a-long-random-secret' \
  goose serve --platform desktop --host 0.0.0.0 --port 3000 --tls
```

| Flag / env | Purpose |
|------------|---------|
| `goose serve` | ACP server over HTTP + WebSocket (not `goose acp` stdio) |
| `--host 0.0.0.0` | Accept non-local connections (default is `127.0.0.1`) |
| `--port 3000` | Example; CLI default is `3284` |
| `--tls` / `GOOSE_TLS=true` | Encrypt transport; enables cert fingerprint pinning |
| `GOOSE_SERVER__SECRET_KEY` | Shared secret; required unless `--dangerously-unauthenticated` |
| `--platform desktop` | Align server platform metadata with Desktop-oriented remote use (as in remote-server docs) |
| `--with-builtin …` | Optional builtins; default includes `developer` if none passed |
| `--allowed-origin <origin>` | For browser/PWA clients; replaces default loopback CORS allowlist when set |

### What the phone must **not** be

| Pattern | Why not |
|---------|---------|
| **Archived goose Mobile** (agent-on-device) | Runs automation *on the phone* (notifications, device MCP). Opposite of “agent on remote PC.” |
| **Local tool execution on phone** | Phone has no remote host filesystem/shell; tools must run where the agent process is. |

---

## 2. Connectivity and security (reuse existing goose server)

### Protocol (do not invent a new one)

```
Phone client  ──HTTPS/WSS──►  goose serve (remote host)
                    │
                    ├── GET  /status  (or /health)  — liveness, no ACP session
                    └── /acp         — ACP Streamable HTTP + WebSocket
                         auth: X-Secret-Key header
                         or   ?token= for browser WebSocket
```

Implementation anchors in-repo:

- Router: `crates/goose/src/acp/transport/mod.rs` — `/acp`, `/status`, `/health`, MCP app proxy
- Auth middleware: `crates/goose/src/acp/transport/auth.rs` — `X-Secret-Key` or `?token=`
- CLI: `goose serve --host/--port/--tls/--tls-cert-path/--tls-key-path/--allowed-origin/--dangerously-unauthenticated`
- Docs: `documentation/docs/guides/remote-goose-server.md`, `CUSTOM_DISTROS.md` Option 1

### Auth and TLS (minimum bar for anything beyond localhost)

1. **Always set `GOOSE_SERVER__SECRET_KEY`** to a long random secret (password manager).
2. **Always use `--tls`** (or `GOOSE_TLS=true`) when the phone is not on a fully trusted private path *and* you care about confidentiality of prompts, secret, and tool output.
3. **Optional cert pinning:** server logs `GOOSED_CERT_FINGERPRINT=…` on TLS start. Clients (Desktop today; phone should mirror) pin that SHA-256 fingerprint so a MITM cannot swap certs.
4. **Never** expose `0.0.0.0` on the public internet with plain HTTP and no secret.
5. **Never** use `--dangerously-unauthenticated` on a network-reachable host with shell-capable builtins.

Verify on the host (and from another machine via VPN hostname, not only `127.0.0.1`):

```bash
curl -i https://HOST:3000/status -k
curl -i https://HOST:3000/acp -k -H 'X-Secret-Key: YOUR_SECRET'
# 401 => wrong/missing secret
# 406 on bare GET /acp with correct secret => auth OK (missing ACP stream headers is expected for this probe)
```

### How the phone *reaches* the host (pick one; no new NAT product)

| Path | When to use | Notes |
|------|-------------|--------|
| **LAN** | Same Wi‑Fi as the host | `--host 0.0.0.0`, use LAN IP/hostname; still use TLS+secret |
| **VPN / tailnet** (Tailscale, WireGuard, corporate VPN) | **Recommended default** for phone-away-from-home | Phone dials stable private IP; firewall only allows tailnet |
| **Reverse tunnel** (Cloudflare Tunnel, SSH `-R`, ngrok-class) | Host behind hard NAT, no VPN | Terminate TLS at tunnel or on goose; keep secret; prefer private access over raw public port forward |
| **Raw public port forward** | Discouraged | If unavoidable: TLS + strong secret + firewall allowlist + short-lived exposure |

**Non-goal:** building multi-user OAuth or a marketplace tunnel product. Prefer VPN/tailnet.

### CORS / browser origins (PWA path)

Default ACP CORS allows loopback web origins. A PWA served from `https://app.example` must start the server with explicit origins:

```bash
GOOSE_SERVER__SECRET_KEY='…' goose serve --host 0.0.0.0 --port 3000 --tls \
  --allowed-origin 'https://app.example'
```

Native apps that do not send browser Origin constraints are simpler on CORS; they still need the secret (and TLS).

---

## 3. Mobile client approach and minimum UX

### Recommended client strategy (phased)

| Phase | Approach | Rationale |
|-------|----------|-----------|
| **P0 (fastest, proven)** | Use **goose Desktop “External Backend”** from a laptop on the same VPN as the phone’s target | Same remote `goose serve` path already documented; validates agent before mobile UI work |
| **P1 (primary mobile recommendation)** | **Mobile web app / PWA** talking ACP to `goose serve` | Matches CUSTOM_DISTROS “custom UI over goose serve”; one codebase; installable on home screen; uses `?token=` for WebSocket if needed |
| **P2 (optional)** | Thin **native shell** (React Native / Kotlin / Swift) wrapping the same ACP HTTP client patterns | Better secure storage of secret, cert pinning, background reconnect — still thin client |

### Client integration surface (reuse, don’t re-protocol)

- **TypeScript:** `@aaif/goose-sdk` — `GooseClient` over ACP stream (`createHttpStream(serverUrl)` / base URL under which `/acp` lives).
- **Desktop reference:** Settings → External Backend — base URL, Secret Key, optional Certificate Fingerprint; readiness via `/status`, session via `/acp`.
- **TUI reference:** `ui/text` can target `--server http://HOST:PORT` with `GOOSE_SERVER__SECRET_KEY` on the server.
- **Protocol methods (minimum):** `initialize` → `session/new` (or `session/load`) → `session/prompt` with streaming updates → permission callbacks → `session/cancel` as needed.

Auth wiring for HTTP clients:

- Header: `X-Secret-Key: <same as GOOSE_SERVER__SECRET_KEY>`
- Browser WS: `wss://HOST:PORT/acp?token=<secret>`

### Minimum session UX surface (phone)

| Surface | Behavior |
|---------|----------|
| **Connect** | Enter base URL (`https://host:port`), secret, optional cert fingerprint; test `/status`; show connected/disconnected |
| **Chat** | Message compose + conversation transcript |
| **Stream replies** | Token/chunk streaming and incremental assistant messages over ACP |
| **Tool activity** | Collapsed/expandable tool-call status (name, running/done, short result summary) |
| **Approvals** | Modal for tool permission requests (allow once / always / reject) when server/client capabilities require it |
| **Session** | New session; optional resume/list if exposed by server methods already used by Desktop |
| **Errors** | Clear 401 (bad secret), TLS/fingerprint mismatch, network unreachable |

Out of minimum scope for v1: full extension management UI, recipe editor, multi-account OAuth, push notifications product.

### Alternate “chat from phone” without a custom app

Experimental **Telegram Gateway** (`documentation/docs/experimental/remote-access/telegram-gateway.md`) can forward messages from any device with Telegram to a goose process. That is a **messaging gateway**, not a full ACP mobile UI (weaker tool-activity UX, different trust model). Useful as a stopgap; not a substitute for the ACP thin client design above.

---

## 4. Day-2 operations and constraints

### On the remote host

| Concern | Recommendation |
|---------|----------------|
| **Provider keys** | Configure on the **host** (`config.yaml` / secrets store / env). Phone never needs OpenAI/Anthropic keys if the agent is fully configured server-side. |
| **Extensions / tools** | Enabled on the host only. Developer shell, filesystem, MCP servers see the **remote machine’s** cwd, home, network, and credentials. |
| **Working directory / projects** | Point sessions at host paths (repos on the remote disk). Phone paths are meaningless to host tools. |
| **Keep-alive** | Run under a supervisor: macOS `launchd` (see remote-goose-server.md), Linux `systemd` user/service unit with `Restart=always`, or container restart policy. Redirect logs; capture `GOOSED_CERT_FINGERPRINT` from stdout. |
| **Updates** | Update goose binary on host; restart service; if TLS cert regenerated, refresh phone fingerprint pin. |
| **Secret rotation** | Change `GOOSE_SERVER__SECRET_KEY` on host and every client (phone + Desktop); they are not synchronized automatically. |
| **Resource** | LLM API spend and CPU for tools run on host; size host for expected concurrency. |

### Explicit constraints (call out in product copy)

1. **Phone has no local shell/files of the remote host** — browsing phone photos does not give the agent those files unless the user uploads/pastes content into chat.
2. **Agent tools execute only in the remote environment** — “delete file X” deletes on the server, not on the phone.
3. **Public internet without TLS + secret is unsafe** — full RCE-class risk via developer tools if unauthenticated or cleartext MITM steals the secret.
4. **Shared secret is single-tenant** — not multi-user RBAC; anyone with the secret is the operator.
5. **Approvals still matter** — remote agent + powerful builtins means permission UX on the phone is security-critical, not cosmetic.

### Example Linux keep-alive (sketch)

```ini
# /etc/systemd/system/goose-serve.service (illustrative)
[Service]
Environment=GOOSE_SERVER__SECRET_KEY=…   # better: EnvironmentFile= with 600 perms
ExecStart=/usr/local/bin/goose serve --platform desktop --host 0.0.0.0 --port 3000 --tls
Restart=always
```

---

## 5. How this differs from existing / archived products

| Product / feature | What it is | Relation to this design |
|-------------------|------------|-------------------------|
| **Archived goose Mobile** (`documentation/docs/experimental/goose-mobile.md`) | Agent **on the phone** with deep device automation | **Not** the solution path. Opposite deployment: tools on device, not remote PC. |
| **Retired Desktop mobile tunnel / QR** (`experimental/remote-access/mobile-access.md`) | Desktop started a tunnel + QR for a mobile app; APIs removed | Do **not** depend on revived tunnel UI. Use VPN/tunnel outside goose + standard `goose serve`. |
| **Desktop External Backend** | Settings: Use external server, URL, Secret Key, optional cert fingerprint → remote `goose serve` | **Proven reference client** for the exact same remote agent path a phone should use. |
| **CLI / TUI** | Local or `--server http://HOST:PORT` ACP clients | Same protocol family; good for debugging remote serve before mobile polish. |
| **Telegram Gateway** | Chat relay via bot | Optional convenience channel; not full ACP tool UX. |

### Mental model

```
                    ┌─────────────────────────────┐
  Phone PWA/app     │  Remote computer            │
  (thin UI)         │                             │
       │            │  goose serve (ACP :3000 TLS)│
       │  ACP       │       │                     │
       └────────────┼───────┤                     │
                    │       ▼                     │
                    │  Agent interactive loop     │
                    │       │                     │
                    │       ▼                     │
                    │  Extensions / MCP tools     │
                    │  (shell, files on THIS box) │
                    └─────────────────────────────┘
```

Desktop can sit on the same left-hand “thin UI” side as the phone.

---

## 6. Recommended deployment recipe (end-to-end)

### A. Remote host (once)

1. Install goose; configure provider + desired extensions on the host.
2. Generate secret; enable TLS.
3. Start:

   ```bash
   GOOSE_SERVER__SECRET_KEY='…' \
     goose serve --platform desktop --host 0.0.0.0 --port 3000 --tls
   ```

4. Put under `systemd` / `launchd` / container with restart-on-failure.
5. Join host to Tailscale (or equivalent); note `100.x` / MagicDNS name.
6. Confirm `/status` and authenticated `/acp` probe from another device on the tailnet.
7. Record `GOOSED_CERT_FINGERPRINT` if pinning.

### B. Phone (client)

1. Reach host only over VPN/tailnet (or LAN).
2. Open PWA/native client (or temporary Desktop external backend for validation).
3. Connect: `https://goose-host:3000` + secret + optional fingerprint.
4. New session → chat → stream → tool activity → approve tools as needed.

### C. Security checklist before leaving home network

- [ ] Secret set and not committed to git
- [ ] TLS on
- [ ] Bound appropriately; not world-open without firewall
- [ ] VPN preferred over raw public port
- [ ] Fingerprint pinned if using self-signed TLS over untrusted networks
- [ ] `--dangerously-unauthenticated` **off**
- [ ] Operator understands tools run as the host user

---

## 7. Non-goals

- Production-hardening the mobile client (offline, multi-account, push product)
- New CLI flags or changes to Desktop external-server UI (beyond shared SDK auth)
- Reviving archived goose-mobile (agent-on-device)
- Full multi-user auth / OAuth / RBAC
- Solving arbitrary NAT beyond recommending VPN / reverse tunnel options
- Native cert pinning (browser cannot pin; P2 native shell)

---

## 8. Implementation roadmap

1. **Validate** remote serve with Desktop external backend on VPN. *(operator step)*
2. **Spike** mobile PWA using `@aaif/goose-sdk` / ACP HTTP stream + secret header — **done** in `ui/mobile` + SDK `secretKey`.
3. **Secure storage** of secret + cert pin on device. *(browser: localStorage; native pin still P2)*
4. **Permission UX** parity with Desktop/TUI for tool approvals. *(basic modal in PWA v1)*
5. Only later: native wrappers, optional Telegram as secondary channel.

---

## References (in-repo)

| Doc / code | Use |
|------------|-----|
| `documentation/docs/guides/remote-goose-server.md` | Remote `goose serve` + Desktop external backend |
| `documentation/docs/guides/acp-clients.md` | Auth, `?token=`, `--allowed-origin`, TUI `--server` |
| `documentation/docs/guides/environment-variables.md` | `GOOSE_TLS*`, `GOOSE_SERVER__SECRET_KEY` |
| `CUSTOM_DISTROS.md` | Custom UI (web/mobile) over `goose serve` ACP |
| `documentation/docs/goose-architecture/goose-architecture.md` | Interface vs agent vs extensions |
| `documentation/docs/experimental/goose-mobile.md` | Archived agent-on-phone (non-path) |
| `documentation/docs/experimental/remote-access/mobile-access.md` | Retired Desktop tunnel |
| `crates/goose-cli/src/cli.rs` | `Serve` flags and secret requirement |
| `crates/goose/src/acp/transport/` | `/acp`, `/status`, auth, TLS setup |
| `ui/sdk` (`@aaif/goose-sdk`) | TypeScript ACP client |
| `ui/desktop/.../ExternalBackendSection.tsx` | Reference client settings UX |
