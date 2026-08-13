import { useEffect, useMemo, useState } from "react";
import {
  filterSavedSessions,
  formatSessionActivity,
  formatSessionCwd,
  sessionActivityAt,
  sessionDisplayName,
  sessionMessageLabel,
  type SavedSession,
} from "../sessions";
import { formatConnectError } from "../url";

type Props = {
  sessions: SavedSession[];
  currentSessionId: string | null;
  listError: string | null;
  isPrompting: boolean;
  onBack: () => void;
  onRefresh: () => Promise<SavedSession[]>;
  onOpen: (session: SavedSession) => Promise<void>;
};

export function SessionsScreen({
  sessions,
  currentSessionId,
  listError,
  isPrompting,
  onBack,
  onRefresh,
  onOpen,
}: Props) {
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(sessions.length === 0);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void onRefresh()
      .catch((err: unknown) => {
        if (!cancelled) setLocalError(formatConnectError(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [onRefresh]);

  const visible = useMemo(
    () => filterSavedSessions(sessions, query),
    [sessions, query],
  );

  const error = localError ?? listError;
  const busy = openingId !== null || isPrompting;

  async function handleRefresh() {
    setLocalError(null);
    setLoading(true);
    try {
      await onRefresh();
    } catch (err: unknown) {
      setLocalError(formatConnectError(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleOpen(session: SavedSession) {
    if (busy) return;
    if (session.id === currentSessionId) {
      onBack();
      return;
    }
    setLocalError(null);
    setOpeningId(session.id);
    try {
      await onOpen(session);
    } catch (err: unknown) {
      setLocalError(formatConnectError(err));
      setOpeningId(null);
    }
  }

  return (
    <div className="screen sessions-screen">
      <header className="sessions-header">
        <div className="sessions-header-main">
          <h1>Sessions</h1>
          <p className="sessions-subtitle">
            Saved chats on the remote host
          </p>
        </div>
        <div className="sessions-header-actions">
          <button
            type="button"
            className="btn ghost small"
            onClick={() => {
              void handleRefresh();
            }}
            disabled={loading || busy}
          >
            {loading ? "Loading…" : "Refresh"}
          </button>
          <button
            type="button"
            className="btn ghost small"
            onClick={onBack}
            disabled={openingId !== null}
          >
            Back
          </button>
        </div>
      </header>

      <div className="sessions-search">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search name, id, or folder…"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          disabled={busy}
        />
      </div>

      {error && (
        <div className="banner error sessions-error" role="alert">
          {error}
        </div>
      )}

      <main className="sessions-list" aria-live="polite">
        {loading && sessions.length === 0 && (
          <p className="sessions-empty">Loading saved sessions…</p>
        )}
        {!loading && sessions.length === 0 && !error && (
          <div className="sessions-empty">
            <p>No saved sessions yet.</p>
            <p className="hint">
              Start a chat, then it will appear here so you can reopen it later.
            </p>
          </div>
        )}
        {!loading && sessions.length > 0 && visible.length === 0 && (
          <div className="sessions-empty">
            <p>No matching sessions.</p>
            <p className="hint">Try a different name, id, or folder.</p>
          </div>
        )}
        {visible.length > 0 && (
          <ul className="session-card-list">
            {visible.map((session) => {
              const current = session.id === currentSessionId;
              const opening = openingId === session.id;
              const activity = formatSessionActivity(sessionActivityAt(session));
              return (
                <li key={session.id}>
                  <button
                    type="button"
                    className={
                      current ? "session-card current" : "session-card"
                    }
                    disabled={busy && !opening}
                    onClick={() => {
                      void handleOpen(session);
                    }}
                  >
                    <div className="session-card-top">
                      <span className="session-card-title">
                        {sessionDisplayName(session)}
                      </span>
                      {current && (
                        <span className="session-badge">Current</span>
                      )}
                      {opening && (
                        <span className="session-badge">Opening…</span>
                      )}
                    </div>
                    {session.lastMessageSnippet && (
                      <p className="session-card-snippet">
                        {session.lastMessageSnippet}
                      </p>
                    )}
                    <p className="session-card-meta">
                      {activity && (
                        <>
                          <span>{activity}</span>
                          <span aria-hidden>·</span>
                        </>
                      )}
                      <span>{sessionMessageLabel(session.messageCount)}</span>
                      {session.cwd && (
                        <>
                          <span aria-hidden>·</span>
                          <span className="mono" title={session.cwd}>
                            {formatSessionCwd(session.cwd)}
                          </span>
                        </>
                      )}
                    </p>
                    <p className="session-card-id mono" title={session.id}>
                      {session.id}
                    </p>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </main>
    </div>
  );
}
