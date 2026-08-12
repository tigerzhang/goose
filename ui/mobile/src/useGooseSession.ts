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

export type GooseSessionApi = {
  connectionState: ConnectionState;
  connectionError: string | null;
  sessionId: string | null;
  messages: ChatMessage[];
  isPrompting: boolean;
  statusLine: string | null;
  pendingPermission: PendingPermission | null;
  connect: (config: ConnectionConfig) => Promise<boolean>;
  disconnect: () => void;
  newSession: () => Promise<void>;
  sendPrompt: (text: string) => Promise<void>;
  cancelPrompt: () => Promise<void>;
  resolvePermission: (action: PermissionAction) => void;
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

  const handleSessionUpdate = useCallback(
    (params: SessionNotification) => {
      const update = params.update;
      if (update.sessionUpdate === "agent_message_chunk") {
        if (update.content.type === "text") {
          const chunk = update.content.text;
          setMessages((prev) => {
            const next = [...prev];
            const streamId = streamingMsgIdRef.current;
            if (streamId) {
              const idx = next.findIndex((m) => m.id === streamId);
              if (idx >= 0) {
                next[idx] = {
                  ...next[idx]!,
                  text: next[idx]!.text + chunk,
                  streaming: true,
                };
                return next;
              }
            }
            const id = newId("assistant");
            streamingMsgIdRef.current = id;
            next.push({
              id,
              role: "assistant",
              text: chunk,
              streaming: true,
              toolCalls: [],
            });
            return next;
          });
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
    [upsertToolCall],
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
    connect,
    disconnect,
    newSession,
    sendPrompt,
    cancelPrompt,
    resolvePermission,
  };
}
