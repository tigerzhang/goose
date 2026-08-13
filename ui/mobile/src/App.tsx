import { useCallback, useEffect, useMemo, useState } from "react";
import { ChatScreen } from "./components/ChatScreen";
import { ConnectScreen } from "./components/ConnectScreen";
import { PermissionModal } from "./components/PermissionModal";
import { SessionsScreen } from "./components/SessionsScreen";
import { hashForView, viewFromHash, type MobileView } from "./navigation";
import { loadConnectionConfig } from "./storage";
import { useGooseSession } from "./useGooseSession";

export default function App() {
  const [savedConfig] = useState(() => loadConnectionConfig());
  const [view, setViewState] = useState<MobileView>(() => viewFromHash(window.location.hash));
  const session = useGooseSession();

  useEffect(() => {
    const sync = () => setViewState(viewFromHash(window.location.hash));
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  const setView = useCallback((next: MobileView) => {
    const hash = hashForView(next);
    if (window.location.hash !== hash) {
      window.location.hash = hash;
    } else {
      setViewState(next);
    }
  }, []);

  const serverLabel = useMemo(() => {
    if (session.connectionState !== "connected") return "";
    try {
      const cfg = loadConnectionConfig();
      return cfg.baseUrl || "connected";
    } catch {
      return "connected";
    }
  }, [session.connectionState]);

  const connected =
    session.connectionState === "connected" && session.sessionId;

  function handleDisconnect() {
    setView("chat");
    session.disconnect();
  }

  if (connected) {
    return (
      <>
        {view === "sessions" ? (
          <SessionsScreen
            sessions={session.resumeSessions}
            currentSessionId={session.sessionId}
            listError={session.sessionsError}
            isPrompting={session.isPrompting}
            onBack={() => setView("chat")}
            onRefresh={session.refreshResumeSessions}
            onOpen={async (saved) => {
              if (saved.id !== session.sessionId) {
                await session.resumeSession(saved.id);
              }
              setView("chat");
            }}
          />
        ) : (
          <ChatScreen
            session={session}
            serverLabel={serverLabel}
            onDisconnect={handleDisconnect}
            onOpenSessions={() => setView("sessions")}
          />
        )}
        {session.pendingPermission && (
          <PermissionModal
            pending={session.pendingPermission}
            onResolve={session.resolvePermission}
          />
        )}
      </>
    );
  }

  return (
    <ConnectScreen
      initial={savedConfig}
      connectionState={session.connectionState}
      connectionError={session.connectionError}
      onConnect={async (config) => {
        const ok = await session.connect(config);
        if (ok) setView("chat");
        return ok;
      }}
    />
  );
}
