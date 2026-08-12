import { useState, type FormEvent } from "react";
import { probeServer } from "../connection";
import { saveConnectionConfig } from "../storage";
import type { ConnectionConfig, ConnectionState } from "../types";
import {
  formatConnectError,
  isAbsoluteHostPath,
  normalizeBaseUrl,
} from "../url";

type Props = {
  initial: ConnectionConfig;
  connectionState: ConnectionState;
  connectionError: string | null;
  onConnect: (config: ConnectionConfig) => Promise<boolean>;
};

export function ConnectScreen({
  initial,
  connectionState,
  connectionError,
  onConnect,
}: Props) {
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl);
  const [secretKey, setSecretKey] = useState(initial.secretKey);
  const [certFingerprint, setCertFingerprint] = useState(
    initial.certFingerprint,
  );
  const [cwd, setCwd] = useState(initial.cwd || "");
  const [localError, setLocalError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const error = localError ?? connectionError;
  const isBusy = busy || connectionState === "checking";

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLocalError(null);
    setBusy(true);
    try {
      const normalized = normalizeBaseUrl(baseUrl);
      const hostCwd = cwd.trim();
      if (!isAbsoluteHostPath(hostCwd)) {
        setLocalError(
          "Host working directory must be an absolute path on the remote machine (e.g. /home/you/projects). Relative paths like “.” are rejected.",
        );
        return;
      }
      const config: ConnectionConfig = {
        baseUrl: normalized,
        secretKey: secretKey.trim(),
        certFingerprint: certFingerprint.trim(),
        cwd: hostCwd,
      };

      const probe = await probeServer(config);
      if (!probe.ok) {
        setLocalError(probe.error);
        return;
      }

      saveConnectionConfig(config);
      const ok = await onConnect(config);
      if (!ok) {
        // connectionError is set by the hook
      }
    } catch (err) {
      setLocalError(formatConnectError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="screen connect-screen">
      <header className="connect-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden>
            🪿
          </span>
          <div>
            <h1>goose Remote</h1>
            <p className="subtitle">
              Thin phone client for a remote <code>goose serve</code> agent
            </p>
          </div>
        </div>
      </header>

      <form className="card form" onSubmit={handleSubmit}>
        <label className="field">
          <span>Server base URL</span>
          <input
            type="url"
            inputMode="url"
            autoComplete="url"
            placeholder="https://100.x.x.x:3000"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            required
            disabled={isBusy}
          />
          <span className="hint">
            Base URL only — goose checks /status and connects to /acp under this
            base.
          </span>
        </label>

        <label className="field">
          <span>Secret key</span>
          <input
            type="password"
            autoComplete="current-password"
            placeholder="GOOSE_SERVER__SECRET_KEY"
            value={secretKey}
            onChange={(e) => setSecretKey(e.target.value)}
            required
            disabled={isBusy}
          />
          <span className="hint">
            Same value as <code>GOOSE_SERVER__SECRET_KEY</code> on the host.
          </span>
        </label>

        <label className="field">
          <span>Host working directory</span>
          <input
            type="text"
            placeholder="/home/you/projects"
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            disabled={isBusy}
            spellCheck={false}
            required
          />
          <span className="hint">
            Absolute path on the remote computer (must exist). Not this phone.
            Tools and the session cwd run there — e.g.{" "}
            <code>/home/you</code> or <code>/tmp</code>.
          </span>
        </label>

        <label className="field">
          <span>Certificate fingerprint (optional)</span>
          <input
            type="text"
            className="mono"
            placeholder="Stored for reference; browsers cannot pin TLS"
            value={certFingerprint}
            onChange={(e) => setCertFingerprint(e.target.value)}
            disabled={isBusy}
            spellCheck={false}
          />
          <span className="hint">
            Self-signed certs must be trusted by the OS/browser. True pinning
            needs a native shell (P2).
          </span>
        </label>

        {error && (
          <div className="banner error" role="alert">
            {error}
          </div>
        )}

        <button type="submit" className="btn primary" disabled={isBusy}>
          {isBusy ? "Connecting…" : "Connect"}
        </button>
      </form>

      <aside className="card tips">
        <h2>Host setup</h2>
        <pre className="code-block">{`GOOSE_SERVER__SECRET_KEY='…' \\
  goose serve --platform desktop \\
  --host 0.0.0.0 --port 3000 --tls \\
  --allowed-origin 'https://YOUR_PWA_ORIGIN'`}</pre>
        <ul>
          <li>Prefer Tailscale/VPN over public port forward.</li>
          <li>
            For this PWA origin, pass <code>--allowed-origin</code> on the
            server (replaces loopback CORS defaults).
          </li>
          <li>
            Phone never runs shell/files — only the remote host does.
          </li>
        </ul>
      </aside>
    </div>
  );
}
