import { useEffect, useRef, useState, type FormEvent } from "react";
import type { GooseSessionApi } from "../useGooseSession";
import { PermissionModal } from "./PermissionModal";
import { ToolCallCard } from "./ToolCallCard";

type Props = {
  session: GooseSessionApi;
  serverLabel: string;
  onDisconnect: () => void;
};

export function ChatScreen({ session, serverLabel, onDisconnect }: Props) {
  const [draft, setDraft] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const {
    messages,
    isPrompting,
    statusLine,
    sessionId,
    pendingPermission,
    sendPrompt,
    cancelPrompt,
    newSession,
    resolvePermission,
  } = session;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, statusLine, pendingPermission]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const text = draft;
    if (!text.trim() || isPrompting) return;
    setDraft("");
    await sendPrompt(text);
  }

  return (
    <div className="screen chat-screen">
      <header className="chat-header">
        <div className="chat-header-main">
          <div className="status-row">
            <span className="status-dot connected" aria-hidden />
            <span className="status-label">Connected</span>
          </div>
          <p className="server-label" title={serverLabel}>
            {serverLabel}
          </p>
          {sessionId && (
            <p className="session-id mono" title={sessionId}>
              session {sessionId.slice(0, 8)}…
            </p>
          )}
        </div>
        <div className="chat-header-actions">
          <button
            type="button"
            className="btn ghost small"
            onClick={() => {
              void newSession().catch((err: unknown) => {
                console.error("Failed to create session", err);
              });
            }}
            disabled={isPrompting}
          >
            New
          </button>
          <button
            type="button"
            className="btn ghost small"
            onClick={onDisconnect}
          >
            Disconnect
          </button>
        </div>
      </header>

      <main className="transcript" aria-live="polite">
        {messages.length === 0 && (
          <div className="empty-state">
            <p>Send a message to the remote agent.</p>
            <p className="hint">
              Tools and files run on the host, not on this phone.
            </p>
          </div>
        )}
        {messages.map((msg) => (
          <article key={msg.id} className={`bubble ${msg.role}`}>
            {msg.role !== "system" && (
              <header className="bubble-role">
                {msg.role === "user" ? "You" : "goose"}
                {msg.streaming ? " …" : ""}
              </header>
            )}
            {msg.text && <div className="bubble-text">{msg.text}</div>}
            {msg.toolCalls?.map((tool) => (
              <ToolCallCard key={tool.toolCallId} tool={tool} />
            ))}
          </article>
        ))}
        {statusLine && <p className="status-line">{statusLine}</p>}
        <div ref={bottomRef} />
      </main>

      <form className="composer" onSubmit={(e) => void handleSubmit(e)}>
        <textarea
          rows={2}
          placeholder="Message the remote agent…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void handleSubmit(e);
            }
          }}
          disabled={isPrompting && draft.length === 0}
        />
        <div className="composer-actions">
          {isPrompting ? (
            <button
              type="button"
              className="btn danger"
              onClick={() => void cancelPrompt()}
            >
              Stop
            </button>
          ) : (
            <button
              type="submit"
              className="btn primary"
              disabled={!draft.trim()}
            >
              Send
            </button>
          )}
        </div>
      </form>

      {pendingPermission && (
        <PermissionModal
          pending={pendingPermission}
          onResolve={resolvePermission}
        />
      )}
    </div>
  );
}
