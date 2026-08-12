/** Normalize a goose serve base URL (before /acp). */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Server URL is required");
  }

  const url = new URL(trimmed);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("URL must use http: or https:");
  }
  if (url.search || url.hash) {
    throw new Error("URL must not include query parameters or fragments");
  }

  const pathname = url.pathname.replace(/\/+$/, "");
  if (pathname.endsWith("/acp")) {
    throw new Error("Use the base URL before /acp (e.g. https://host:3000)");
  }

  return `${url.origin}${pathname}`;
}

export function statusUrl(baseUrl: string): string {
  const base = normalizeBaseUrl(baseUrl);
  return `${base}/status`;
}

export function acpProbeUrl(baseUrl: string, secretKey?: string): string {
  const base = normalizeBaseUrl(baseUrl);
  const url = new URL(`${base}/acp`);
  if (secretKey) {
    url.searchParams.set("token", secretKey);
  }
  return url.toString();
}

function acpErrorData(error: unknown): unknown {
  if (typeof error !== "object" || error === null) return undefined;
  const withNested =
    "error" in error &&
    typeof (error as { error: unknown }).error === "object" &&
    (error as { error: unknown }).error !== null
      ? (error as { error: Record<string, unknown> }).error
      : (error as Record<string, unknown>);
  return "data" in withNested ? withNested.data : undefined;
}

/** Absolute path on the *remote host* (POSIX or Windows). */
export function isAbsoluteHostPath(cwd: string): boolean {
  const t = cwd.trim();
  if (!t) return false;
  if (t.startsWith("/")) return true;
  // Windows: C:\ or C:/
  return /^[A-Za-z]:[/\\]/.test(t);
}

export function formatConnectError(error: unknown): string {
  const data = acpErrorData(error);
  if (typeof data === "string" && data.trim()) {
    if (data.includes("absolute path") || data.includes("invalid directory")) {
      return `${data}. Set “Host working directory” to an absolute path that exists on the remote machine (e.g. /home/you/projects).`;
    }
    return data;
  }

  if (!(error instanceof Error)) {
    return String(error);
  }
  const msg = error.message;
  if (msg === "Invalid params" || msg.includes("Invalid params")) {
    return "Invalid params — host working directory must be an absolute path that exists on the remote machine (not “.”).";
  }
  if (msg.includes("Failed to fetch") || msg.includes("NetworkError")) {
    return "Network unreachable. Check VPN/LAN, host URL, and that goose serve is running.";
  }
  if (msg.includes("401") || msg.includes("403") || msg.includes("X-Secret-Key")) {
    return "Authentication failed (401). Check the secret key matches GOOSE_SERVER__SECRET_KEY.";
  }
  if (msg.includes("certificate") || msg.includes("SSL") || msg.includes("TLS")) {
    return "TLS error. Self-signed certs must be trusted by the OS/browser; fingerprint pinning needs a native client.";
  }
  return msg;
}
