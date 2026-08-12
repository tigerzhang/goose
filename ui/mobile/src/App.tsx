import { useMemo, useState } from "react";
import { ChatScreen } from "./components/ChatScreen";
import { ConnectScreen } from "./components/ConnectScreen";
import { loadConnectionConfig } from "./storage";
import { useGooseSession } from "./useGooseSession";

export default function App() {
  const [savedConfig] = useState(() => loadConnectionConfig());
  const session = useGooseSession();

  const serverLabel = useMemo(() => {
    if (session.connectionState !== "connected") return "";
    try {
      const cfg = loadConnectionConfig();
      return cfg.baseUrl || "connected";
    } catch {
      return "connected";
    }
  }, [session.connectionState]);

  if (session.connectionState === "connected" && session.sessionId) {
    return (
      <ChatScreen
        session={session}
        serverLabel={serverLabel}
        onDisconnect={() => session.disconnect()}
      />
    );
  }

  return (
    <ConnectScreen
      initial={savedConfig}
      connectionState={session.connectionState}
      connectionError={session.connectionError}
      onConnect={session.connect}
    />
  );
}
