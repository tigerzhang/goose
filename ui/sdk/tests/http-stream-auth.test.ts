import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHttpStream } from "../src/http-stream.js";

describe("createHttpStream auth headers", () => {
  it("sends X-Secret-Key on initialize POST", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push({ url, init });

      if (init?.method === "POST") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 0,
            result: {
              protocolVersion: 1,
              agentCapabilities: {},
              agentInfo: { name: "test", version: "0" },
            },
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "Acp-Connection-Id": "conn-1",
            },
          },
        );
      }

      // SSE GET — empty stream that ends immediately
      return new Response("", {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as typeof fetch;

    try {
      const stream = createHttpStream("http://127.0.0.1:3000", {
        secretKey: "test-secret",
      });

      const writer = stream.writable.getWriter();
      await writer.write({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: 1,
          clientInfo: { name: "test", version: "0" },
          clientCapabilities: {},
        },
      });

      const post = calls.find((c) => c.init?.method === "POST");
      assert.ok(post, "expected initialize POST");
      const headers = new Headers(post.init?.headers);
      assert.equal(headers.get("X-Secret-Key"), "test-secret");
      assert.equal(post.url, "http://127.0.0.1:3000/acp");

      await writer.close().catch(() => undefined);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("opens a session GET stream before session/load so replayed history can arrive", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push({ url, init });

      if (init?.method === "POST") {
        const method = (JSON.parse(String(init.body ?? "{}")) as { method?: string })
          .method;
        if (method === "initialize") {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 0,
              result: {
                protocolVersion: 1,
                agentCapabilities: {},
                agentInfo: { name: "test", version: "0" },
              },
            }),
            {
              status: 200,
              headers: {
                "Content-Type": "application/json",
                "Acp-Connection-Id": "conn-1",
              },
            },
          );
        }
        return new Response(null, { status: 202 });
      }

      return new Response("", {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as typeof fetch;

    try {
      const stream = createHttpStream("http://127.0.0.1:3000", {
        secretKey: "test-secret",
      });
      const writer = stream.writable.getWriter();

      await writer.write({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: 1,
          clientInfo: { name: "test", version: "0" },
          clientCapabilities: {},
        },
      });

      await writer.write({
        jsonrpc: "2.0",
        id: 1,
        method: "session/load",
        params: {
          sessionId: "sess-resume",
          cwd: "/tmp",
          mcpServers: [],
        },
      });

      const loadPostIndex = calls.findIndex((c) => {
        if (c.init?.method !== "POST") return false;
        try {
          return (
            (JSON.parse(String(c.init.body ?? "{}")) as { method?: string })
              .method === "session/load"
          );
        } catch {
          return false;
        }
      });
      assert.ok(loadPostIndex >= 0, "expected session/load POST");

      const sessionGet = calls.find((c, i) => {
        if (i >= loadPostIndex) return false;
        if ((c.init?.method ?? "GET") !== "GET") return false;
        const headers = new Headers(c.init?.headers);
        return headers.get("Acp-Session-Id") === "sess-resume";
      });
      assert.ok(
        sessionGet,
        "expected session-scoped GET before session/load POST",
      );

      await writer.close().catch(() => undefined);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
