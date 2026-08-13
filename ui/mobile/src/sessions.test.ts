import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionInfo } from "@agentclientprotocol/sdk";
import {
  filterSavedSessions,
  formatSessionActivity,
  formatSessionCwd,
  sessionActivityAt,
  sessionDisplayName,
  sessionInfoToSaved,
  sessionMessageLabel,
  type SavedSession,
} from "./sessions.ts";

function session(
  overrides: Partial<SavedSession> & Pick<SavedSession, "id" | "name">,
): SavedSession {
  return {
    cwd: "/tmp",
    messageCount: 3,
    ...overrides,
  };
}

describe("sessionDisplayName", () => {
  it("uses the trimmed name, or (unnamed)", () => {
    assert.equal(sessionDisplayName({ name: "  work  " }), "work");
    assert.equal(sessionDisplayName({ name: "" }), "(unnamed)");
    assert.equal(sessionDisplayName({ name: "   " }), "(unnamed)");
  });
});

describe("sessionMessageLabel", () => {
  it("pluralizes message counts", () => {
    assert.equal(sessionMessageLabel(0), "0 msgs");
    assert.equal(sessionMessageLabel(1), "1 msg");
    assert.equal(sessionMessageLabel(12), "12 msgs");
  });
});

describe("sessionActivityAt", () => {
  it("prefers lastMessageAt over updatedAt", () => {
    assert.equal(
      sessionActivityAt(
        session({
          id: "1",
          name: "a",
          lastMessageAt: "2026-08-13T12:00:00.000Z",
          updatedAt: "2026-08-01T00:00:00.000Z",
        }),
      ),
      "2026-08-13T12:00:00.000Z",
    );
    assert.equal(
      sessionActivityAt(
        session({
          id: "2",
          name: "b",
          updatedAt: "2026-08-01T00:00:00.000Z",
        }),
      ),
      "2026-08-01T00:00:00.000Z",
    );
  });
});

describe("formatSessionActivity", () => {
  const now = Date.parse("2026-08-13T12:00:00.000Z");

  it("returns empty for missing or invalid timestamps", () => {
    assert.equal(formatSessionActivity(undefined, now), "");
    assert.equal(formatSessionActivity("not-a-date", now), "");
  });

  it("formats relative times", () => {
    assert.equal(
      formatSessionActivity("2026-08-13T11:59:30.000Z", now),
      "just now",
    );
    assert.equal(
      formatSessionActivity("2026-08-13T11:45:00.000Z", now),
      "15m ago",
    );
    assert.equal(
      formatSessionActivity("2026-08-13T09:00:00.000Z", now),
      "3h ago",
    );
    assert.equal(
      formatSessionActivity("2026-08-12T12:00:00.000Z", now),
      "yesterday",
    );
  });
});

describe("formatSessionCwd", () => {
  it("leaves short paths alone and ellipsizes long ones", () => {
    assert.equal(formatSessionCwd("/home/you"), "/home/you");
    const long = "/home/you/projects/goose/crates/goose/src/agents";
    const formatted = formatSessionCwd(long, 24);
    assert.ok(formatted.startsWith("…"));
    assert.ok(formatted.length <= 24);
    assert.ok(formatted.endsWith("agents"));
  });
});

describe("filterSavedSessions", () => {
  const sessions: SavedSession[] = [
    session({
      id: "old",
      name: "older-work",
      cwd: "/tmp/old",
      lastMessageAt: "2026-08-01T00:00:00.000Z",
      lastMessageSnippet: "fix the login form",
    }),
    session({
      id: "new",
      name: "react-migration",
      cwd: "/home/you/app",
      lastMessageAt: "2026-08-13T00:00:00.000Z",
      messageCount: 12,
    }),
    session({
      id: "empty",
      name: "",
      cwd: "/tmp",
      messageCount: 0,
      updatedAt: "2026-08-10T00:00:00.000Z",
    }),
  ];

  it("sorts by activity, newest first", () => {
    const names = filterSavedSessions(sessions, "").map((s) => s.id);
    assert.deepEqual(names, ["new", "empty", "old"]);
  });

  it("matches name, id, cwd, and snippet", () => {
    assert.equal(filterSavedSessions(sessions, "react").length, 1);
    assert.equal(filterSavedSessions(sessions, "empty").length, 1);
    assert.equal(filterSavedSessions(sessions, "/home/you").length, 1);
    assert.equal(filterSavedSessions(sessions, "login").length, 1);
    assert.equal(filterSavedSessions(sessions, "nope").length, 0);
  });
});

describe("sessionInfoToSaved", () => {
  it("maps ACP SessionInfo plus goose _meta fields", () => {
    const info = {
      sessionId: "abc",
      cwd: "/work",
      title: "  titled  ",
      updatedAt: "2026-08-13T00:00:00.000Z",
      _meta: {
        messageCount: 4,
        lastMessageAt: "2026-08-13T01:00:00.000Z",
        lastMessageSnippet: "hello",
      },
    } as SessionInfo;
    assert.deepEqual(sessionInfoToSaved(info), {
      id: "abc",
      name: "titled",
      cwd: "/work",
      messageCount: 4,
      updatedAt: "2026-08-13T00:00:00.000Z",
      lastMessageAt: "2026-08-13T01:00:00.000Z",
      lastMessageSnippet: "hello",
    });
  });
});
