import {
  DEFAULT_CONNECTION,
  STORAGE_KEY,
  type ConnectionConfig,
} from "./types";

export function loadConnectionConfig(): ConnectionConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_CONNECTION };
    const parsed = JSON.parse(raw) as Partial<ConnectionConfig>;
    return {
      baseUrl: typeof parsed.baseUrl === "string" ? parsed.baseUrl : "",
      secretKey: typeof parsed.secretKey === "string" ? parsed.secretKey : "",
      certFingerprint:
        typeof parsed.certFingerprint === "string"
          ? parsed.certFingerprint
          : "",
      cwd:
        typeof parsed.cwd === "string" && parsed.cwd && parsed.cwd !== "."
          ? parsed.cwd
          : "",
    };
  } catch {
    return { ...DEFAULT_CONNECTION };
  }
}

export function saveConnectionConfig(config: ConnectionConfig): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

export function clearConnectionConfig(): void {
  localStorage.removeItem(STORAGE_KEY);
}
