import type { SessionInfo } from "@agentclientprotocol/sdk";

/** A saved session from `session/list`, used by /resume and the Sessions page. */
export interface SavedSession {
  id: string;
  name: string;
  cwd: string;
  messageCount: number;
  updatedAt?: string | null;
  lastMessageAt?: string;
  lastMessageSnippet?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function sessionInfoToSaved(info: SessionInfo): SavedSession {
  const meta = info._meta;
  const messageCount =
    isRecord(meta) && typeof meta.messageCount === "number"
      ? meta.messageCount
      : 0;
  const lastMessageAt =
    isRecord(meta) && typeof meta.lastMessageAt === "string"
      ? meta.lastMessageAt
      : undefined;
  const lastMessageSnippet =
    isRecord(meta) && typeof meta.lastMessageSnippet === "string"
      ? meta.lastMessageSnippet
      : undefined;
  return {
    id: String(info.sessionId),
    name: (info.title ?? "").trim(),
    cwd: info.cwd,
    messageCount,
    updatedAt: info.updatedAt,
    lastMessageAt,
    lastMessageSnippet,
  };
}

export function sessionDisplayName(session: Pick<SavedSession, "name">): string {
  return session.name.trim() || "(unnamed)";
}

export function sessionMessageLabel(count: number): string {
  return count === 1 ? "1 msg" : `${count} msgs`;
}

export function sessionActivityAt(session: SavedSession): string | undefined {
  return session.lastMessageAt ?? session.updatedAt ?? undefined;
}

export function formatSessionActivity(
  iso: string | null | undefined,
  now = Date.now(),
): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";

  const deltaSec = Math.round((now - then) / 1000);
  if (deltaSec < 45) return "just now";
  if (deltaSec < 3600) {
    const mins = Math.max(1, Math.round(deltaSec / 60));
    return `${mins}m ago`;
  }
  if (deltaSec < 86400) {
    const hours = Math.max(1, Math.round(deltaSec / 3600));
    return `${hours}h ago`;
  }
  if (deltaSec < 86400 * 2) return "yesterday";

  return new Date(then).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export function formatSessionCwd(cwd: string, max = 40): string {
  if (cwd.length <= max) return cwd;
  return `…${cwd.slice(-(max - 1))}`;
}

export function filterSavedSessions(
  sessions: readonly SavedSession[],
  query: string,
): SavedSession[] {
  const q = query.trim().toLowerCase();
  const filtered = q
    ? sessions.filter((session) => {
        const snippet = session.lastMessageSnippet ?? "";
        return (
          session.name.toLowerCase().includes(q) ||
          session.id.toLowerCase().includes(q) ||
          session.cwd.toLowerCase().includes(q) ||
          snippet.toLowerCase().includes(q)
        );
      })
    : [...sessions];

  filtered.sort((a, b) => {
    const ta = Date.parse(sessionActivityAt(a) ?? "") || 0;
    const tb = Date.parse(sessionActivityAt(b) ?? "") || 0;
    if (ta !== tb) return tb - ta;
    return sessionDisplayName(a).localeCompare(sessionDisplayName(b));
  });
  return filtered;
}
