import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isResumeArgInput,
  matchResumeSessions,
  matchSlashCommands,
  resumeArgPrefix,
  tryRunSlashCommand,
  type SavedSession,
} from "./slashCommands.ts";

function session(
  overrides: Partial<SavedSession> & Pick<SavedSession, "id" | "name">,
): SavedSession {
  return {
    cwd: "/tmp",
    messageCount: 3,
    ...overrides,
  };
}

const SESSIONS: SavedSession[] = [
  session({ id: "20260326_1", name: "older-work", messageCount: 4 }),
  session({ id: "20260326_2", name: "react-migration", messageCount: 12 }),
  session({
    id: "20260326_3",
    name: "current-work",
    messageCount: 2,
  }),
  session({ id: "20260326_4", name: "empty-skipped", messageCount: 0 }),
  session({ id: "20260326_5", name: "", messageCount: 5 }),
];

describe("resumeArgPrefix", () => {
  it("is null while the command name is still being typed", () => {
    assert.equal(resumeArgPrefix("/"), null);
    assert.equal(resumeArgPrefix("/re"), null);
    assert.equal(resumeArgPrefix("/resume"), null);
    assert.equal(resumeArgPrefix("/resumex"), null);
    assert.equal(isResumeArgInput("/resume"), false);
  });

  it("returns the first-argument prefix after /resume", () => {
    assert.equal(resumeArgPrefix("/resume "), "");
    assert.equal(resumeArgPrefix("/resume re"), "re");
    assert.equal(resumeArgPrefix("  /resume  2026"), "2026");
    assert.equal(isResumeArgInput("/resume "), true);
  });

  it("stops after a second token", () => {
    assert.equal(resumeArgPrefix("/resume name extra"), null);
    assert.equal(isResumeArgInput("/resume name extra"), false);
  });
});

describe("matchResumeSessions", () => {
  it("lists non-empty, non-current sessions after /resume ", () => {
    const suggestions = matchResumeSessions(
      "/resume ",
      SESSIONS,
      "20260326_3",
    );
    assert.equal(suggestions.length, 3);
    assert.ok(suggestions.every((s) => s.kind === "session"));
    assert.ok(suggestions.some((s) => s.name === "older-work"));
    assert.ok(suggestions.some((s) => s.name === "react-migration"));
    assert.ok(suggestions.some((s) => s.name === "(unnamed)"));
    assert.ok(!suggestions.some((s) => s.name === "current-work"));
    assert.ok(!suggestions.some((s) => s.name === "empty-skipped"));
  });

  it("matches a name prefix and completes to the name", () => {
    const suggestions = matchResumeSessions("/resume re", SESSIONS);
    assert.equal(suggestions.length, 1);
    assert.equal(suggestions[0]?.name, "react-migration");
    assert.equal(suggestions[0]?.completion, "/resume react-migration ");
    assert.match(suggestions[0]?.description ?? "", /12 msgs/);
  });

  it("matches a session id prefix and completes to the id", () => {
    const suggestions = matchResumeSessions("/resume 20260326_1", SESSIONS);
    assert.equal(suggestions.length, 1);
    assert.equal(suggestions[0]?.name, "older-work");
    assert.equal(suggestions[0]?.completion, "/resume 20260326_1 ");
  });

  it("does not treat (unnamed) as a searchable name", () => {
    const suggestions = matchResumeSessions("/resume (un", SESSIONS);
    assert.equal(suggestions.length, 0);
  });
});

describe("matchSlashCommands", () => {
  it("still completes command names before a space", () => {
    const suggestions = matchSlashCommands("/re");
    assert.ok(suggestions.some((s) => s.name === "resume"));
    assert.equal(
      suggestions.find((s) => s.name === "resume")?.completion,
      "/resume ",
    );
  });

  it("offers /sessions in the command list", () => {
    const suggestions = matchSlashCommands("/s");
    assert.ok(suggestions.some((s) => s.name === "sessions"));
  });

  it("switches to session completions after /resume ", () => {
    const suggestions = matchSlashCommands("/resume ", {
      sessions: SESSIONS,
      currentSessionId: "20260326_3",
    });
    assert.ok(suggestions.length > 0);
    assert.ok(suggestions.every((s) => s.kind === "session"));
  });
});

describe("tryRunSlashCommand /resume", () => {
  it("opens the sessions page when no target is given", () => {
    const result = tryRunSlashCommand("/resume");
    assert.deepEqual(result, {
      handled: true,
      action: "sessions",
    });
  });

  it("resumes locally when a target is given", () => {
    const result = tryRunSlashCommand("/resume react-migration");
    assert.deepEqual(result, {
      handled: true,
      action: "resume",
      target: "react-migration",
    });
  });
});

describe("tryRunSlashCommand /sessions", () => {
  it("opens the sessions page", () => {
    assert.deepEqual(tryRunSlashCommand("/sessions"), {
      handled: true,
      action: "sessions",
    });
  });
});
