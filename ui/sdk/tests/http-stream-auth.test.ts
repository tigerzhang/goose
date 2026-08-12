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
});
