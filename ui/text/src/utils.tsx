export function isErrorStatus(status: string): boolean {
  return status.startsWith("error") || status.startsWith("failed");
}

export function formatError(e: unknown): string {
  if (e instanceof Error) {
    return e.message || e.toString();
  }
  if (typeof e === "string") {
    return e;
  }
  if (e && typeof e === "object") {
    try {
      return JSON.stringify(e, null, 2);
    } catch {
      return String(e);
    }
  }
  return String(e);
}

/** Compact token counts: `842`, `1.2k`, `12k`, `1.2M`. */
export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 1000) return Math.round(n).toString();
  const [value, suffix] =
    n >= 1_000_000 ? [n / 1_000_000, "M"] : [n / 1000, "k"];
  const text =
    value < 10 ? value.toFixed(1).replace(/\.0$/, "") : Math.round(value).toString();
  return `${text}${suffix}`;
}

export function contextUsagePercent(used: number, size: number): number {
  if (!size || size <= 0) return 0;
  return Math.min(100, Math.round((used / size) * 100));
}
