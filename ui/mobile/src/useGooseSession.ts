import { useCallback, useEffect, useRef, useState } from "react";
import {
  GooseClient,
  type GooseClientCallbacks,
} from "@aaif/goose-sdk";
import {
  PROTOCOL_VERSION,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import { formatConnectError } from "./url";
import {
  permissionKey,
  permissionResponseForAction,
} from "./permissions";
import type {
  ChatMessage,
  ConnectionConfig,
  ConnectionState,
  PendingPermission,
  PermissionAction,
} from "./types";
import {
  sessionInfoToSaved,
  type SavedSession,
} from "./sessions";
import {
  applyAcpSessionUpdate,
  finalizeStreaming,
  newMessageId,
  visibleMessageCount,
} from "./transcript";

function resolveSavedSession(
  target: string,
  sessions: readonly SavedSession[],
): SavedSession | undefined {
  const needle = target.trim().toLowerCase();
  if (!needle) return undefined;
  return (
    sessions.find(
      (s) => s.id.toLowerCase() === needle || s.name.toLowerCase() === needle,
    ) ??
    sessions.find(
      (s) =>
        s.id.toLowerCase().startsWith(needle) ||
        s.name.toLowerCase().startsWith(needle),
    )
  );
}

export type GooseSessionApi = {
  connectionState: ConnectionState;
  connectionError: string | null;
  sessionId: string | null;
  /** Display name of the loaded session, when known. */
  sessionTitle: string | null;
  messages: ChatMessage[];
  /** User/assistant turns restored by the last `/resume`. */
  restoredCount: number;
  isPrompting: boolean;
  statusLine: string | null;
  pendingPermission: PendingPermission | null;
  /** Cached saved sessions for `/resume` autocomplete and the Sessions page. */
  resumeSessions: SavedSession[];
  /** Last error from listing saved sessions, if any. */
  sessionsError: string | null;
  connect: (config: ConnectionConfig) => Promise<boolean>;
  disconnect: () => void;
  newSession: () => Promise<void>;
  sendPrompt: (text: string) => Promise<void>;
  /** Local-only: clear transcript UI without creating a new session. */
  clearMessages: () => void;
  /**
   * Append a local user bubble and optional system reply without contacting the agent
   * (e.g. /help).
   */
  appendLocalExchange: (userText: string, systemText?: string) => void;
  cancelPrompt: () => Promise<void>;
  resolvePermission: (action: PermissionAction) => void;
  refreshResumeSessions: () => Promise<SavedSession[]>;
  resumeSession: (target: string) => Promise<void>;
};

export function useGooseSession(): GooseSessionApi {
  const clientRef = useRef<GooseClient | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const configRef = useRef<ConnectionConfig | null>(null);
  const permissionResolvers = useRef(
    new Map<string, (response: RequestPermissionResponse) => void>(),
  );

  const [connectionState, setConnectionState] =
    useState<ConnectionState>("disconnected");
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionTitle, setSessionTitle] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [restoredCount, setRestoredCount] = useState(0);
  const [isPrompting, setIsPrompting] = useState(false);
  const [statusLine, setStatusLine] = useState<string | null>(null);
  const [pendingPermission, setPendingPermission] =
    useState<PendingPermission | null>(null);
  const [resumeSessions, setResumeSessions] = useState<SavedSession[]>([]);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const transcriptEpochRef = useRef(0);
  const messagesRef = useRef<ChatMessage[]>([]);
  const replayingRef = useRef(false);
  const resumeSessionsRef = useRef<SavedSession[]>([]);
  const refreshResumeSessionsRef = useRef<
    (() => Promise<SavedSession[]>) | null
  >(null);

  const replaceMessages = useCallback((next: ChatMessage[]) => {
    messagesRef.current = next;
    setMessages(next);
  }, []);

  const updateMessages = useCallback(
    (fn: (prev: ChatMessage[]) => ChatMessage[]) => {
      replaceMessages(fn(messagesRef.current));
    },
    [replaceMessages],
  );

  const clearPermissionQueue = useCallback(() => {
    for (const resolve of permissionResolvers.current.values()) {
      resolve({ outcome: { outcome: "cancelled" } });
    }
    permissionResolvers.current.clear();
    setPendingPermission(null);
  }, []);

  const disconnect = useCallback(() => {
    clearPermissionQueue();
    clientRef.current = null;
    sessionIdRef.current = null;
    configRef.current = null;
    transcriptEpochRef.current += 1;
    resumeSessionsRef.current = [];
    setResumeSessions([]);
    setSessionsError(null);
    setSessionId(null);
    setSessionTitle(null);
    setRestoredCount(0);
    replaceMessages([]);
    setIsPrompting(false);
    setStatusLine(null);
    setConnectionState("disconnected");
    setConnectionError(null);
  }, [clearPermissionQueue, replaceMessages]);

  const handleSessionUpdate = useCallback(
    (params: SessionNotification) => {
      const active = sessionIdRef.current;
      if (active && String(params.sessionId) !== active) return;
      const epoch = transcriptEpochRef.current;
      const { messages: next } = applyAcpSessionUpdate(
        messagesRef.current,
        params.update,
        { streaming: !replayingRef.current },
      );
      if (transcriptEpochRef.current !== epoch) return;
      replaceMessages(next);
    },
    [replaceMessages],
  );

  const requestPermission = useCallback(
    async (
      params: RequestPermissionRequest,
    ): Promise<RequestPermissionResponse> => {
      const key = permissionKey(params.sessionId, params.toolCall.toolCallId);
      const previous = permissionResolvers.current.get(key);
      if (previous) {
        previous({ outcome: { outcome: "cancelled" } });
      }

      return new Promise<RequestPermissionResponse>((resolve) => {
        permissionResolvers.current.set(key, resolve);
        setPendingPermission({ key, request: params });
      });
    },
    [],
  );

  const resolvePermission = useCallback(
    (action: PermissionAction) => {
      const pending = pendingPermission;
      if (!pending) return;
      const resolve = permissionResolvers.current.get(pending.key);
      permissionResolvers.current.delete(pending.key);
      setPendingPermission(null);
      if (resolve) {
        resolve(permissionResponseForAction(pending.request, action));
      }
    },
    [pendingPermission],
  );

  const createCallbacks = useCallback((): (() => GooseClientCallbacks) => {
    return () => ({
      requestPermission,
      sessionUpdate: async (params) => {
        handleSessionUpdate(params);
      },
      unstable_sessionUpdate: async (notification) => {
        const update = notification.update;
        if (
          update.sessionUpdate === "status_message" &&
          update.status.type === "progress"
        ) {
          setStatusLine(update.status.message);
        }
      },
    });
  }, [handleSessionUpdate, requestPermission]);

  const newSession = useCallback(async () => {
    const client = clientRef.current;
    const config = configRef.current;
    if (!client || !config) {
      throw new Error("Not connected");
    }
    clearPermissionQueue();
    transcriptEpochRef.current += 1;
    setSessionTitle(null);
    setRestoredCount(0);
    replaceMessages([]);
    setStatusLine("Creating session…");
    const cwd = config.cwd.trim();
    if (!cwd.startsWith("/") && !/^[A-Za-z]:[/\\]/.test(cwd)) {
      throw new Error(
        "Host working directory must be an absolute path on the remote machine (e.g. /home/you).",
      );
    }
    const session = await client.newSession({
      cwd,
      mcpServers: [],
    });
    sessionIdRef.current = session.sessionId;
    setSessionId(session.sessionId);
    setStatusLine(null);
    void refreshResumeSessionsRef.current?.();
  }, [clearPermissionQueue, replaceMessages]);

  const connect = useCallback(
    async (config: ConnectionConfig): Promise<boolean> => {
      disconnect();
      setConnectionState("checking");
      setConnectionError(null);
      setStatusLine("Connecting…");

      try {
        const client = new GooseClient(createCallbacks(), {
          url: config.baseUrl.replace(/\/+$/, ""),
          secretKey: config.secretKey,
        });
        clientRef.current = client;
        configRef.current = config;

        setStatusLine("Initializing ACP…");
        await client.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientInfo: {
            name: "goose-mobile",
            version: "0.1.0",
          },
          clientCapabilities: {},
        });

        await newSession();
        setConnectionState("connected");
        setStatusLine(null);
        return true;
      } catch (error) {
        const message = formatConnectError(error);
        setConnectionError(message);
        setConnectionState("error");
        setStatusLine(null);
        clientRef.current = null;
        configRef.current = null;
        return false;
      }
    },
    [createCallbacks, disconnect, newSession],
  );

  const refreshResumeSessions = useCallback(async (): Promise<
    SavedSession[]
  > => {
    const client = clientRef.current;
    if (!client) return [];

    const collected: SavedSession[] = [];
    let cursor: string | undefined;
    const maxPages = 50;

    try {
      for (let page = 0; page < maxPages; page++) {
        const response = await client.listSessions({
          ...(cursor ? { cursor } : {}),
          _meta: { types: ["user", "scheduled", "acp"] },
        });
        collected.push(...response.sessions.map(sessionInfoToSaved));
        const next = response.nextCursor ?? undefined;
        if (!next || next === cursor) break;
        cursor = next;
      }
      resumeSessionsRef.current = collected;
      setResumeSessions(collected);
      setSessionsError(null);
      return collected;
    } catch (error) {
      if (collected.length > 0) {
        resumeSessionsRef.current = collected;
        setResumeSessions(collected);
        setSessionsError(null);
        return collected;
      }
      setSessionsError(formatConnectError(error));
      return resumeSessionsRef.current;
    }
  }, []);

  refreshResumeSessionsRef.current = refreshResumeSessions;

  const resumeSession = useCallback(
    async (target: string) => {
      const client = clientRef.current;
      if (!client) {
        throw new Error("Not connected");
      }

      let sessions = resumeSessionsRef.current;
      if (sessions.length === 0) {
        sessions = await refreshResumeSessions();
      }

      let match = resolveSavedSession(target, sessions);
      if (!match) {
        sessions = await refreshResumeSessions();
        match = resolveSavedSession(target, sessions);
      }
      if (!match) {
        throw new Error(`No session found with name or id '${target}'`);
      }

      const previousId = sessionIdRef.current;
      if (previousId) {
        try {
          await client.cancel({ sessionId: previousId });
        } catch {
          // best-effort
        }
      }
      clearPermissionQueue();
      transcriptEpochRef.current += 1;
      replayingRef.current = true;
      replaceMessages([]);
      setRestoredCount(0);
      setIsPrompting(false);
      setStatusLine("Loading session…");
      sessionIdRef.current = match.id;
      setSessionId(match.id);
      setSessionTitle(match.name.trim() || null);

      try {
        await client.loadSession({
          sessionId: match.id,
          cwd: match.cwd,
          mcpServers: [],
        });
      } catch (error) {
        replayingRef.current = false;
        setStatusLine(null);
        throw error;
      }

      replayingRef.current = false;
      replaceMessages(finalizeStreaming(messagesRef.current));
      setRestoredCount(visibleMessageCount(messagesRef.current));
      setStatusLine(null);
      void refreshResumeSessions();
    },
    [clearPermissionQueue, refreshResumeSessions, replaceMessages],
  );

  const sendPrompt = useCallback(async (text: string) => {
    const client = clientRef.current;
    const sid = sessionIdRef.current;
    if (!client || !sid) {
      throw new Error("No active session");
    }
    const trimmed = text.trim();
    if (!trimmed) return;

    updateMessages((prev) => [
      ...prev,
      { id: newMessageId("user"), role: "user", text: trimmed },
    ]);
    setIsPrompting(true);
    setStatusLine("Thinking…");

    try {
      await client.prompt({
        sessionId: sid,
        prompt: [{ type: "text", text: trimmed }],
      });
    } catch (error) {
      updateMessages((prev) => [
        ...prev,
        {
          id: newMessageId("system"),
          role: "system",
          text: formatConnectError(error),
        },
      ]);
    } finally {
      setIsPrompting(false);
      setStatusLine(null);
      replaceMessages(finalizeStreaming(messagesRef.current));
    }
  }, [replaceMessages, updateMessages]);

  const cancelPrompt = useCallback(async () => {
    const client = clientRef.current;
    const sid = sessionIdRef.current;
    if (!client || !sid) return;
    try {
      await client.cancel({ sessionId: sid });
    } catch {
      // best-effort
    }
  }, []);

  const clearMessages = useCallback(() => {
    transcriptEpochRef.current += 1;
    setRestoredCount(0);
    replaceMessages([]);
    setStatusLine(null);
  }, [replaceMessages]);

  const appendLocalExchange = useCallback(
    (userText: string, systemText?: string) => {
      const user = userText.trim();
      if (!user) return;
      updateMessages((prev) => {
        const next: ChatMessage[] = [
          ...prev,
          { id: newMessageId("user"), role: "user", text: user },
        ];
        const system = systemText?.trim();
        if (system) {
          next.push({
            id: newMessageId("system"),
            role: "system",
            text: system,
          });
        }
        return next;
      });
    },
    [updateMessages],
  );

  useEffect(() => {
    return () => {
      clearPermissionQueue();
      clientRef.current = null;
    };
  }, [clearPermissionQueue]);

  return {
    connectionState,
    connectionError,
    sessionId,
    sessionTitle,
    messages,
    restoredCount,
    isPrompting,
    statusLine,
    pendingPermission,
    resumeSessions,
    sessionsError,
    connect,
    disconnect,
    newSession,
    sendPrompt,
    clearMessages,
    appendLocalExchange,
    cancelPrompt,
    resolvePermission,
    refreshResumeSessions,
    resumeSession,
  };
}
