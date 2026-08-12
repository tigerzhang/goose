import { useCallback, useEffect, useRef, useState } from "react";
import {
  GooseClient,
  type GooseClientCallbacks,
} from "@aaif/goose-sdk";
import {
  PROTOCOL_VERSION,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionInfo,
  type SessionNotification,
  type ToolCallStatus,
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
  ToolCallEntry,
} from "./types";
import type { SavedSession } from "./slashCommands";

function newId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function summarizeRaw(value: unknown, max = 160): string | undefined {
  if (value === undefined || value === null) return undefined;
  try {
    const s =
      typeof value === "string" ? value : JSON.stringify(value, null, 0);
    if (s.length <= max) return s;
    return `${s.slice(0, max - 1)}…`;
  } catch {
    return String(value).slice(0, max);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function chunkMessageId(update: {
  messageId?: string | null;
  _meta?: { [key: string]: unknown } | null;
}): string | undefined {
  if (typeof update.messageId === "string" && update.messageId) {
    return update.messageId;
  }
  const goose = update._meta?.goose;
  if (!isRecord(goose)) return undefined;
  return typeof goose.messageId === "string" && goose.messageId
    ? goose.messageId
    : undefined;
}

function sessionInfoToSaved(info: SessionInfo): SavedSession {
  const meta = info._meta;
  const messageCount =
    isRecord(meta) && typeof meta.messageCount === "number"
      ? meta.messageCount
      : 0;
  return {
    id: String(info.sessionId),
    name: (info.title ?? "").trim(),
    cwd: info.cwd,
    messageCount,
  };
}

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
  messages: ChatMessage[];
  isPrompting: boolean;
  statusLine: string | null;
  pendingPermission: PendingPermission | null;
  /** Cached saved sessions for `/resume` autocomplete. */
  resumeSessions: SavedSession[];
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
  const streamingMsgIdRef = useRef<string | null>(null);
  const permissionResolvers = useRef(
    new Map<string, (response: RequestPermissionResponse) => void>(),
  );

  const [connectionState, setConnectionState] =
    useState<ConnectionState>("disconnected");
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isPrompting, setIsPrompting] = useState(false);
  const [statusLine, setStatusLine] = useState<string | null>(null);
  const [pendingPermission, setPendingPermission] =
    useState<PendingPermission | null>(null);
  const [resumeSessions, setResumeSessions] = useState<SavedSession[]>([]);
  const transcriptEpochRef = useRef(0);
  const resumeSessionsRef = useRef<SavedSession[]>([]);
  const refreshResumeSessionsRef = useRef<
    (() => Promise<SavedSession[]>) | null
  >(null);

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
    streamingMsgIdRef.current = null;
    transcriptEpochRef.current += 1;
    resumeSessionsRef.current = [];
    setResumeSessions([]);
    setSessionId(null);
    setMessages([]);
    setIsPrompting(false);
    setStatusLine(null);
    setConnectionState("disconnected");
    setConnectionError(null);
  }, [clearPermissionQueue]);

  const upsertToolCall = useCallback(
    (toolCallId: string, patch: Partial<ToolCallEntry> & { title?: string }) => {
      setMessages((prev) => {
        const next = [...prev];
        // Prefer attaching tool calls to the latest assistant message, or create one.
        let targetIdx = -1;
        for (let i = next.length - 1; i >= 0; i--) {
          if (next[i]!.role === "assistant") {
            targetIdx = i;
            break;
          }
        }
        if (targetIdx < 0) {
          next.push({
            id: newId("assistant"),
            role: "assistant",
            text: "",
            toolCalls: [],
          });
          targetIdx = next.length - 1;
        }

        const msg = { ...next[targetIdx]! };
        const tools = [...(msg.toolCalls ?? [])];
        const existing = tools.findIndex((t) => t.toolCallId === toolCallId);
        if (existing >= 0) {
          tools[existing] = { ...tools[existing]!, ...patch };
        } else {
          tools.push({
            toolCallId,
            title: patch.title ?? toolCallId,
            status: (patch.status as ToolCallStatus) ?? "pending",
            kind: patch.kind,
            summary: patch.summary,
            expanded: false,
          });
        }
        msg.toolCalls = tools;
        next[targetIdx] = msg;
        return next;
      });
    },
    [],
  );

  const appendTextChunk = useCallback(
    (role: "user" | "assistant", text: string, messageId?: string) => {
      const epoch = transcriptEpochRef.current;
      setMessages((prev) => {
        if (transcriptEpochRef.current !== epoch) return prev;
        const next = [...prev];
        if (messageId) {
          const idx = next.findIndex((m) => m.id === messageId);
          if (idx >= 0) {
            next[idx] = {
              ...next[idx]!,
              text: next[idx]!.text + text,
              streaming: role === "assistant",
            };
            return next;
          }
        }
        if (role === "assistant" && streamingMsgIdRef.current) {
          const idx = next.findIndex((m) => m.id === streamingMsgIdRef.current);
          if (idx >= 0 && next[idx]!.role === "assistant") {
            next[idx] = {
              ...next[idx]!,
              text: next[idx]!.text + text,
              streaming: true,
            };
            return next;
          }
        }
        const id = messageId ?? newId(role);
        if (role === "assistant") {
          streamingMsgIdRef.current = id;
        } else {
          streamingMsgIdRef.current = null;
        }
        next.push({
          id,
          role,
          text,
          streaming: role === "assistant",
          toolCalls: role === "assistant" ? [] : undefined,
        });
        return next;
      });
    },
    [],
  );

  const handleSessionUpdate = useCallback(
    (params: SessionNotification) => {
      const update = params.update;
      if (
        update.sessionUpdate === "agent_message_chunk" ||
        update.sessionUpdate === "user_message_chunk"
      ) {
        if (update.content.type === "text") {
          appendTextChunk(
            update.sessionUpdate === "user_message_chunk"
              ? "user"
              : "assistant",
            update.content.text,
            chunkMessageId(update),
          );
        }
      } else if (update.sessionUpdate === "tool_call") {
        upsertToolCall(update.toolCallId, {
          title: update.title ?? update.toolCallId,
          status: update.status ?? "pending",
          kind: update.kind ?? undefined,
          summary: summarizeRaw(update.rawInput),
        });
      } else if (update.sessionUpdate === "tool_call_update") {
        upsertToolCall(update.toolCallId, {
          title: update.title ?? undefined,
          status: update.status ?? undefined,
          kind: update.kind ?? undefined,
          summary:
            summarizeRaw(update.rawOutput) ?? summarizeRaw(update.rawInput),
        });
      } else if (update.sessionUpdate === "agent_thought_chunk") {
        // Ignore thoughts in v1 UI (could surface later).
      }
    },
    [appendTextChunk, upsertToolCall],
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
    streamingMsgIdRef.current = null;
    transcriptEpochRef.current += 1;
    setMessages([]);
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
  }, [clearPermissionQueue]);

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
    try {
      const response = await client.listSessions({
        _meta: { types: ["user", "scheduled", "acp"] },
      });
      const sessions = response.sessions.map(sessionInfoToSaved);
      resumeSessionsRef.current = sessions;
      setResumeSessions(sessions);
      return sessions;
    } catch {
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
      streamingMsgIdRef.current = null;
      transcriptEpochRef.current += 1;
      setMessages([]);
      setIsPrompting(false);
      setStatusLine("Loading session…");
      sessionIdRef.current = match.id;
      setSessionId(match.id);

      try {
        await client.loadSession({
          sessionId: match.id,
          cwd: match.cwd,
          mcpServers: [],
        });
      } catch (error) {
        setStatusLine(null);
        throw error;
      }

      setStatusLine(null);
      setMessages((prev) =>
        prev.map((m) => (m.streaming ? { ...m, streaming: false } : m)),
      );
      void refreshResumeSessions();
    },
    [clearPermissionQueue, refreshResumeSessions],
  );

  const sendPrompt = useCallback(async (text: string) => {
    const client = clientRef.current;
    const sid = sessionIdRef.current;
    if (!client || !sid) {
      throw new Error("No active session");
    }
    const trimmed = text.trim();
    if (!trimmed) return;

    streamingMsgIdRef.current = null;
    setMessages((prev) => [
      ...prev,
      { id: newId("user"), role: "user", text: trimmed },
    ]);
    setIsPrompting(true);
    setStatusLine("Thinking…");

    try {
      await client.prompt({
        sessionId: sid,
        prompt: [{ type: "text", text: trimmed }],
      });
    } catch (error) {
      setMessages((prev) => [
        ...prev,
        {
          id: newId("system"),
          role: "system",
          text: formatConnectError(error),
        },
      ]);
    } finally {
      setIsPrompting(false);
      setStatusLine(null);
      streamingMsgIdRef.current = null;
      setMessages((prev) =>
        prev.map((m) =>
          m.streaming ? { ...m, streaming: false } : m,
        ),
      );
    }
  }, []);

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
    streamingMsgIdRef.current = null;
    transcriptEpochRef.current += 1;
    setMessages([]);
    setStatusLine(null);
  }, []);

  const appendLocalExchange = useCallback(
    (userText: string, systemText?: string) => {
      const user = userText.trim();
      if (!user) return;
      setMessages((prev) => {
        const next: ChatMessage[] = [
          ...prev,
          { id: newId("user"), role: "user", text: user },
        ];
        const system = systemText?.trim();
        if (system) {
          next.push({ id: newId("system"), role: "system", text: system });
        }
        return next;
      });
    },
    [],
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
    messages,
    isPrompting,
    statusLine,
    pendingPermission,
    resumeSessions,
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
