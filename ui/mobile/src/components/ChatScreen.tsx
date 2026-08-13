import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import type { GooseSessionApi } from "../useGooseSession";
import { formatConnectError } from "../url";
import {
  isResumeArgInput,
  matchSlashCommands,
  SLASH_AUTOCOMPLETE_MAX,
  STARTUP_GUIDE_COMMANDS,
  tryRunSlashCommand,
} from "../slashCommands";
import { ToolCallCard } from "./ToolCallCard";

type Props = {
  session: GooseSessionApi;
  serverLabel: string;
  onDisconnect: () => void;
  onOpenSessions: () => void;
};

export function ChatScreen({
  session,
  serverLabel,
  onDisconnect,
  onOpenSessions,
}: Props) {
  const [draft, setDraft] = useState("");
  const [selectedSuggestion, setSelectedSuggestion] = useState(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const {
    messages,
    isPrompting,
    statusLine,
    sessionId,
    sessionTitle,
    restoredCount,
    sendPrompt,
    cancelPrompt,
    newSession,
    clearMessages,
    appendLocalExchange,
    resumeSessions,
    refreshResumeSessions,
    resumeSession,
  } = session;

  const resumeArgMode = isResumeArgInput(draft);

  useEffect(() => {
    if (resumeArgMode) {
      void refreshResumeSessions().catch(() => {});
    }
  }, [resumeArgMode, refreshResumeSessions]);

  const suggestions = useMemo(
    () =>
      matchSlashCommands(draft, {
        sessions: resumeSessions,
        currentSessionId: sessionId,
      }).slice(0, SLASH_AUTOCOMPLETE_MAX),
    [draft, resumeSessions, sessionId],
  );

  useEffect(() => {
    setSelectedSuggestion(0);
  }, [draft]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, statusLine]);

  function applySuggestion(completion: string) {
    setDraft(completion);
    textareaRef.current?.focus();
  }

  async function runInput(text: string) {
    const trimmed = text.trim();
    if (!trimmed || isPrompting) return;

    if (trimmed.startsWith("/")) {
      const result = tryRunSlashCommand(trimmed);
      if (result.handled) {
        setDraft("");
        if ("action" in result) {
          if (result.action === "exit") {
            onDisconnect();
            return;
          }
          if (result.action === "clear") {
            // Clear local UI immediately, then tell the agent so host history is wiped.
            clearMessages();
            await sendPrompt("/clear");
            return;
          }
          if (result.action === "agent") {
            await sendPrompt(result.text);
            return;
          }
          if (result.action === "sessions") {
            onOpenSessions();
            return;
          }
          if (result.action === "resume") {
            try {
              await resumeSession(result.target);
            } catch (err: unknown) {
              appendLocalExchange(trimmed, formatConnectError(err));
            }
            return;
          }
        }
        if ("message" in result && result.message) {
          appendLocalExchange(trimmed, result.message);
        }
        return;
      }
    }

    setDraft("");
    await sendPrompt(trimmed);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    await runInput(draft);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (suggestions.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedSuggestion((i) => (i + 1) % suggestions.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedSuggestion(
          (i) => (i - 1 + suggestions.length) % suggestions.length,
        );
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        const pick = suggestions[selectedSuggestion];
        if (pick) applySuggestion(pick.completion);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDraft(draft.startsWith("/") ? "" : draft);
        return;
      }
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const pick = suggestions[selectedSuggestion];
      if (pick?.kind === "session") {
        void runInput(pick.completion);
        return;
      }
      void handleSubmit(e);
    }
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
          {sessionTitle && (
            <p className="session-title" title={sessionTitle}>
              {sessionTitle}
            </p>
          )}
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
            onClick={onOpenSessions}
            disabled={isPrompting}
          >
            Sessions
          </button>
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
        {messages.length === 0 && !statusLine && (
          <div className="empty-state">
            <p>Send a message to the remote agent.</p>
            <p className="hint">
              Tools and files run on the host, not on this phone.
            </p>
            <div className="splash-guide" aria-label="Inline commands">
              <p className="splash-guide-title">· inline commands</p>
              <ul className="splash-guide-list">
                {STARTUP_GUIDE_COMMANDS.map(({ cmd, desc }) => (
                  <li key={cmd}>
                    <button
                      type="button"
                      className="splash-cmd"
                      disabled={isPrompting}
                      onClick={() => {
                        void runInput(cmd);
                      }}
                    >
                      <span className="splash-cmd-name mono">{cmd}</span>
                      <span className="splash-cmd-desc">{desc}</span>
                    </button>
                  </li>
                ))}
              </ul>
              <p className="hint splash-hint">
                Type / for suggestions · Sessions or /resume opens saved chats
              </p>
            </div>
          </div>
        )}
        {restoredCount > 0 && (
          <p className="restore-banner">
            ↻ {restoredCount} {restoredCount === 1 ? "message" : "messages"}{" "}
            restored
          </p>
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
            {msg.images?.map((image, index) => (
              <img
                key={`${msg.id}-img-${index}`}
                className="bubble-image"
                src={`data:${image.mimeType};base64,${image.data}`}
                alt=""
              />
            ))}
            {msg.toolCalls?.map((tool) => (
              <ToolCallCard key={tool.toolCallId} tool={tool} />
            ))}
          </article>
        ))}
        {statusLine && <p className="status-line">{statusLine}</p>}
        <div ref={bottomRef} />
      </main>

      <form className="composer" onSubmit={(e) => void handleSubmit(e)}>
        {suggestions.length > 0 && (
          <ul
            className="slash-suggestions"
            role="listbox"
            aria-label={resumeArgMode ? "Saved sessions" : "Commands"}
          >
            {suggestions.map((s, i) => (
              <li key={`${s.kind ?? "command"}:${s.completion}`}>
                <button
                  type="button"
                  role="option"
                  aria-selected={i === selectedSuggestion}
                  className={
                    i === selectedSuggestion
                      ? "slash-suggestion active"
                      : "slash-suggestion"
                  }
                  onMouseDown={(e) => {
                    e.preventDefault();
                  }}
                  onClick={() => {
                    if (s.kind === "session") {
                      void runInput(s.completion);
                    } else {
                      applySuggestion(s.completion);
                    }
                  }}
                >
                  <span
                    className={
                      s.kind === "session"
                        ? "slash-suggestion-name session"
                        : "slash-suggestion-name mono"
                    }
                  >
                    {s.kind === "session" ? s.name : `/${s.name}`}
                  </span>
                  <span className="slash-suggestion-desc">{s.description}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <textarea
          ref={textareaRef}
          rows={2}
          placeholder="Message or /command…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isPrompting && draft.length === 0}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
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

    </div>
  );
}
