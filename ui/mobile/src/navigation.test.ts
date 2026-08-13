import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hashForView, viewFromHash } from "./navigation.ts";

describe("viewFromHash", () => {
  it("treats missing or chat hashes as chat", () => {
    assert.equal(viewFromHash(""), "chat");
    assert.equal(viewFromHash("#"), "chat");
    assert.equal(viewFromHash("#/"), "chat");
    assert.equal(viewFromHash("#/chat"), "chat");
  });

  it("recognizes the sessions page", () => {
    assert.equal(viewFromHash("#/sessions"), "sessions");
    assert.equal(viewFromHash("#sessions"), "sessions");
    assert.equal(viewFromHash("#/sessions/"), "sessions");
  });
});

describe("hashForView", () => {
  it("round-trips the sessions page", () => {
    assert.equal(hashForView("sessions"), "#/sessions");
    assert.equal(viewFromHash(hashForView("sessions")), "sessions");
    assert.equal(viewFromHash(hashForView("chat")), "chat");
  });
});
