import type { SessionNotification, ToolCallStatus } from "@agentclientprotocol/sdk";
import type { ChatMessage, ToolCallEntry } from "./types";

export function newMessageId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function visibleMessageCount(messages: readonly ChatMessage[]): number {
  return messages.filter((m) => m.role !== "system").length;
}

export function finalizeStreaming(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => (m.streaming ? { ...m, streaming: false } : m));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function chunkMessageId(update: {
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

export function summarizeRaw(value: unknown, max = 160): string | undefined {
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

export type ApplySessionUpdateOptions = {
  /** Live assistant chunks are marked streaming; replayed history is not. */
  streaming?: boolean;
};

export type ApplySessionUpdateResult = {
  messages: ChatMessage[];
  addedVisible: number;
};

function appendContentChunk(
  messages: ChatMessage[],
  role: "user" | "assistant",
  chunk:
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string },
  messageId: string | undefined,
  streaming: boolean,
): ApplySessionUpdateResult {
  const next = [...messages];
  if (messageId) {
    const idx = next.findIndex((m) => m.id === messageId);
    if (idx >= 0) {
      const existing = next[idx]!;
      if (chunk.type === "text") {
        next[idx] = {
          ...existing,
          text: existing.text + chunk.text,
          streaming: streaming && role === "assistant",
        };
      } else {
        next[idx] = {
          ...existing,
          images: [
            ...(existing.images ?? []),
            { data: chunk.data, mimeType: chunk.mimeType },
          ],
          streaming: streaming && role === "assistant",
        };
      }
      return { messages: next, addedVisible: 0 };
    }
  } else if (role === "assistant" && streaming) {
    for (let i = next.length - 1; i >= 0; i--) {
      const existing = next[i]!;
      if (existing.role !== "assistant" || !existing.streaming) continue;
      if (chunk.type === "text") {
        next[i] = { ...existing, text: existing.text + chunk.text, streaming: true };
      } else {
        next[i] = {
          ...existing,
          images: [
            ...(existing.images ?? []),
            { data: chunk.data, mimeType: chunk.mimeType },
          ],
          streaming: true,
        };
      }
      return { messages: next, addedVisible: 0 };
    }
  }

  const id = messageId ?? newMessageId(role);
  if (chunk.type === "text") {
    next.push({
      id,
      role,
      text: chunk.text,
      streaming: streaming && role === "assistant",
      toolCalls: role === "assistant" ? [] : undefined,
    });
  } else {
    next.push({
      id,
      role,
      text: "",
      images: [{ data: chunk.data, mimeType: chunk.mimeType }],
      streaming: streaming && role === "assistant",
      toolCalls: role === "assistant" ? [] : undefined,
    });
  }
  return { messages: next, addedVisible: 1 };
}

function upsertToolCall(
  messages: ChatMessage[],
  toolCallId: string,
  patch: Partial<ToolCallEntry> & { title?: string },
): ApplySessionUpdateResult {
  const next = [...messages];
  let targetIdx = -1;
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i]!.role === "assistant") {
      targetIdx = i;
      break;
    }
  }
  let addedVisible = 0;
  if (targetIdx < 0) {
    next.push({
      id: newMessageId("assistant"),
      role: "assistant",
      text: "",
      toolCalls: [],
    });
    targetIdx = next.length - 1;
    addedVisible = 1;
  }

  const msg = { ...next[targetIdx]! };
  const tools = [...(msg.toolCalls ?? [])];
  const existing = tools.findIndex((t) => t.toolCallId === toolCallId);
  if (existing >= 0) {
    const current = tools[existing]!;
    tools[existing] = {
      ...current,
      title: patch.title ?? current.title,
      status: patch.status ?? current.status,
      kind: patch.kind ?? current.kind,
      summary: patch.summary ?? current.summary,
    };
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
  return { messages: next, addedVisible };
}

/**
 * Apply one ACP session update to the mobile transcript.
 * Replayed `session/load` history uses the same updates as a live turn.
 */
export function applyAcpSessionUpdate(
  messages: ChatMessage[],
  update: SessionNotification["update"],
  options: ApplySessionUpdateOptions = {},
): ApplySessionUpdateResult {
  const streaming = options.streaming ?? false;

  if (
    update.sessionUpdate === "agent_message_chunk" ||
    update.sessionUpdate === "user_message_chunk"
  ) {
    const role =
      update.sessionUpdate === "user_message_chunk" ? "user" : "assistant";
    if (update.content.type === "text") {
      return appendContentChunk(
        messages,
        role,
        { type: "text", text: update.content.text },
        chunkMessageId(update),
        streaming,
      );
    }
    if (update.content.type === "image") {
      return appendContentChunk(
        messages,
        role,
        {
          type: "image",
          data: update.content.data,
          mimeType: update.content.mimeType,
        },
        chunkMessageId(update),
        streaming,
      );
    }
    return { messages, addedVisible: 0 };
  }

  if (update.sessionUpdate === "tool_call") {
    return upsertToolCall(messages, update.toolCallId, {
      title: update.title ?? update.toolCallId,
      status: update.status ?? "pending",
      kind: update.kind ?? undefined,
      summary: summarizeRaw(update.rawInput),
    });
  }

  if (update.sessionUpdate === "tool_call_update") {
    return upsertToolCall(messages, update.toolCallId, {
      title: update.title ?? undefined,
      status: update.status ?? undefined,
      kind: update.kind ?? undefined,
      summary:
        summarizeRaw(update.rawOutput) ?? summarizeRaw(update.rawInput),
    });
  }

  return { messages, addedVisible: 0 };
}
