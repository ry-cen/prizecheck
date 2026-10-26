import { describe, expect, it } from "vitest";
import { answerSafely, capReaction, reactToLock } from "./lockOutcome";

const row = {
  id: "r",
  printing_id: "p",
  edition_id: "e",
  count: 1,
  candidates: ["p"],
  needs_pick: false,
};

describe("reactToLock", () => {
  it("answers an added lock with added true", () => {
    expect(reactToLock({ added: true, row }, "auto")).toEqual({
      message: { added: true },
      reaction: { kind: "added" },
    });
  });

  it("hints for an automatic lock none of whose candidates can be added", () => {
    expect(reactToLock({ added: false, reason: "unresolved" }, "auto")).toEqual(
      {
        message: { added: false, reason: "unresolved" },
        reaction: { kind: "hint", hint: "unresolved" },
      }
    );
  });

  it("opens search for a shutter that cannot be added, as a miss does", () => {
    expect(
      reactToLock({ added: false, reason: "unresolved" }, "shutter").reaction
    ).toEqual({ kind: "search" });
  });

  it("says offline when the printings route cannot be reached", () => {
    expect(reactToLock({ added: false, reason: "offline" }, "auto")).toEqual({
      message: { added: false, reason: "offline" },
      reaction: { kind: "hint", hint: "offline" },
    });
  });

  it("maps the caps: full and row limit prompt, the Edition limit hints", () => {
    expect(capReaction("full")).toEqual({ kind: "full-prompt" });
    expect(capReaction("row_limit")).toEqual({ kind: "full-prompt" });
    expect(capReaction("edition_limit")).toEqual({
      kind: "hint",
      hint: "edition_limit",
    });
    expect(capReaction("frozen")).toEqual({ kind: "open-tray" });
    const refused = reactToLock(
      { added: false, reason: "full", verdict: "edition_limit" },
      "auto"
    );
    expect(refused.message).toEqual({ added: false, reason: "full" });
    expect(refused.reaction).toEqual({ kind: "hint", hint: "edition_limit" });
  });
});

describe("answerSafely", () => {
  it("passes a result through", async () => {
    const result = { added: true as const, row };
    expect(await answerSafely(async () => result, "auto")).toEqual({
      result,
      via: "auto",
    });
  });

  it("turns a throw into an unresolved lock with the hint, so the voter is answered", async () => {
    const failed = await answerSafely(async () => {
      throw new DOMException("quota", "QuotaExceededError");
    }, "shutter");
    expect(failed.result).toEqual({ added: false, reason: "unresolved" });
    const outcome = reactToLock(failed.result, failed.via);
    expect(outcome.message).toEqual({ added: false, reason: "unresolved" });
    expect(outcome.reaction).toEqual({ kind: "hint", hint: "unresolved" });
  });
});
