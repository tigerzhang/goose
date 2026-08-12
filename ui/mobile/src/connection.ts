import { acpProbeUrl, formatConnectError, normalizeBaseUrl, statusUrl } from "./url";
import type { ConnectionConfig } from "./types";

export type ProbeResult =
  | { ok: true; baseUrl: string }
  | { ok: false; error: string };

/**
 * Probe remote goose serve: /status liveness then authenticated /acp.
 * 406 on bare GET /acp with a valid secret means auth succeeded.
 */
export async function probeServer(
  config: ConnectionConfig,
  timeoutMs = 8_000,
): Promise<ProbeResult> {
  try {
    const baseUrl = normalizeBaseUrl(config.baseUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const statusResponse = await fetch(statusUrl(baseUrl), {
        method: "GET",
        signal: controller.signal,
      });
      if (!statusResponse.ok) {
        return {
          ok: false,
          error: `Server /status returned ${statusResponse.status}`,
        };
      }

      if (!config.secretKey.trim()) {
        return {
          ok: false,
          error: "Secret key is required unless the server is unauthenticated",
        };
      }

      const acpResponse = await fetch(acpProbeUrl(baseUrl, config.secretKey), {
        method: "GET",
        signal: controller.signal,
      });

      if (acpResponse.status === 401 || acpResponse.status === 403) {
        return {
          ok: false,
          error:
            "Authentication failed (401). Check the secret key matches GOOSE_SERVER__SECRET_KEY.",
        };
      }

      // Auth OK but missing ACP stream headers → 406 is expected for this probe.
      if (acpResponse.status === 406 || acpResponse.ok) {
        return { ok: true, baseUrl };
      }

      return {
        ok: false,
        error: `Unexpected /acp response: ${acpResponse.status} ${acpResponse.statusText}`,
      };
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return { ok: false, error: "Connection timed out" };
    }
    return { ok: false, error: formatConnectError(error) };
  }
}
