import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import {
  applyAcpSessionUpdate,
  finalizeStreaming,
  visibleMessageCount,
} from "./transcript.ts";
import type { ChatMessage } from "./types.ts";

function userChunk(
  text: string,
  messageId: string,
): SessionNotification["update"] {
  return {
    sessionUpdate: "user_message_chunk",
    content: { type: "text", text },
    _meta: { goose: { messageId } },
  };
}

function agentChunk(
  text: string,
  messageId: string,
): SessionNotification["update"] {
  return {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text },
    _meta: { goose: { messageId } },
  };
}

describe("applyAcpSessionUpdate replay", () => {
  it("rebuilds user and assistant turns from load-session chunks", () => {
    let messages: ChatMessage[] = [];
    let added = 0;

    for (const update of [
      userChunk("hello", "m1"),
      agentChunk("hi ", "m2"),
      agentChunk("there", "m2"),
    ]) {
      const result = applyAcpSessionUpdate(messages, update, {
        streaming: false,
      });
      messages = result.messages;
      added += result.addedVisible;
    }

    assert.equal(added, 2);
    assert.equal(visibleMessageCount(messages), 2);
    assert.equal(messages[0]?.role, "user");
    assert.equal(messages[0]?.text, "hello");
    assert.equal(messages[0]?.id, "m1");
    assert.equal(messages[1]?.role, "assistant");
    assert.equal(messages[1]?.text, "hi there");
    assert.equal(messages[1]?.streaming, false);
  });

  it("attaches replayed tool calls to the assistant turn", () => {
    let messages: ChatMessage[] = [];
    messages = applyAcpSessionUpdate(messages, agentChunk("working", "a1"), {
      streaming: false,
    }).messages;
    messages = applyAcpSessionUpdate(
      messages,
      {
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "read file",
        status: "pending",
        rawInput: { path: "/tmp/a" },
      },
      { streaming: false },
    ).messages;
    messages = applyAcpSessionUpdate(
      messages,
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        status: "completed",
        rawOutput: { ok: true },
      },
      { streaming: false },
    ).messages;

    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.toolCalls?.length, 1);
    assert.equal(messages[0]?.toolCalls?.[0]?.title, "read file");
    assert.equal(messages[0]?.toolCalls?.[0]?.status, "completed");
    assert.match(messages[0]?.toolCalls?.[0]?.summary ?? "", /ok/);
  });

  it("renders replayed image attachments on the owning message", () => {
    const { messages, addedVisible } = applyAcpSessionUpdate(
      [],
      {
        sessionUpdate: "user_message_chunk",
        content: {
          type: "image",
          data: "abc123",
          mimeType: "image/png",
        },
        _meta: { goose: { messageId: "img1" } },
      },
      { streaming: false },
    );

    assert.equal(addedVisible, 1);
    assert.equal(messages[0]?.id, "img1");
    assert.deepEqual(messages[0]?.images, [
      { data: "abc123", mimeType: "image/png" },
    ]);
  });

  it("marks live assistant chunks as streaming until finalized", () => {
    let messages = applyAcpSessionUpdate([], agentChunk("partial", "live"), {
      streaming: true,
    }).messages;
    assert.equal(messages[0]?.streaming, true);
    messages = finalizeStreaming(messages);
    assert.equal(messages[0]?.streaming, false);
  });

  it("merges live assistant chunks that omit messageId", () => {
    let messages = applyAcpSessionUpdate(
      [],
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Hel" },
      },
      { streaming: true },
    ).messages;
    messages = applyAcpSessionUpdate(
      messages,
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "lo" },
      },
      { streaming: true },
    ).messages;

    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.text, "Hello");
    assert.equal(messages[0]?.streaming, true);
  });
});
