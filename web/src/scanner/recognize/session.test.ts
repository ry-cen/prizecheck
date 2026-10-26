import { describe, expect, it } from "vitest";
import type { FromWorker } from "../worker/messages";
import { VoteSession } from "./session";
import type { VoteFrame } from "./vote";

const SAME = new Uint8Array(1024).fill(100);
const ABSENT = new Uint8Array(1024).fill(200);
const fr = (
  t: number,
  top: string[] | null,
  thumb = SAME,
  eligible = true,
  textBacked = true
): VoteFrame => ({
  t,
  thumb,
  top,
  eligible,
  textBacked,
});
const types = (m: FromWorker[]) => m.map((x) => x.t);

function suggest(s: VoteSession, t0 = 0): FromWorker[] {
  s.frame(fr(t0, ["A", "B", "C"], SAME, true, false), false);
  s.frame(fr(t0 + 100, ["A", "B", "C"], SAME, true, false), false);
  return s.frame(fr(t0 + 200, ["A", "B", "C"], SAME, true, false), false);
}

describe("VoteSession messages", () => {
  it("an image-only agreement posts one suggest lock with up to three ids", () => {
    const s = new VoteSession();
    expect(suggest(s)).toEqual([
      { t: "lock", lockId: 1, printingIds: ["A", "B", "C"], via: "suggest" },
    ]);
  });

  it("a number-backed agreement posts an auto lock", () => {
    const s = new VoteSession();
    s.frame(fr(0, ["A"]), false);
    s.frame(fr(100, ["A"]), false);
    expect(s.frame(fr(200, ["A"]), false)).toEqual([
      { t: "lock", lockId: 1, printingIds: ["A"], via: "auto" },
    ]);
  });

  it("posts absent exactly once when the card leaves, and dismissed then needs a fresh absence", () => {
    const s = new VoteSession();
    suggest(s);
    expect(s.frame(fr(300, null, ABSENT), false)).toEqual([]);
    expect(s.frame(fr(400, null, ABSENT), false)).toEqual([
      { t: "absent", lockId: 1 },
    ]);
    for (let t = 500; t < 1000; t += 100)
      expect(s.frame(fr(t, null, ABSENT), false), `t=${t}`).toEqual([]);
    s.outcome(
      { t: "lockOutcome", lockId: 1, added: false, reason: "dismissed" },
      1000
    );
    expect(s.state).toBe("locked");
    // The same card back in view is not suggested again until a fresh absence.
    for (let t = 1100; t < 1500; t += 100)
      expect(s.frame(fr(t, ["A"], SAME, true, false), false)).toEqual([]);
    s.frame(fr(1500, null, ABSENT), false);
    s.frame(fr(1600, null, ABSENT), false);
    expect(s.state).toBe("armed");
  });

  it("a pending suggestion blocks new events", () => {
    const s = new VoteSession();
    suggest(s);
    for (let t = 300; t < 900; t += 100)
      expect(types(s.frame(fr(t, ["Z"]), false))).toEqual([]);
  });

  it("the shutter does nothing while a suggestion is pending, and a stray shutter frame is dropped", () => {
    const s = new VoteSession();
    suggest(s);
    expect(s.shutter(400)).toEqual([]);
    expect(s.takeShutter()).toBe(false);
    expect(s.frame(fr(500, null), true)).toEqual([]); // no miss
    expect(s.state).toBe("pending");
  });

  it("the shutter locks the window when fresh and posts miss with no candidate", () => {
    const s = new VoteSession();
    s.frame(fr(0, ["A", "B"]), false);
    expect(s.shutter(100)).toEqual([
      { t: "lock", lockId: 1, printingIds: ["A", "B"], via: "shutter" },
    ]);
    const m = new VoteSession();
    expect(m.shutter(100)).toEqual([]); // needs a frame
    expect(m.takeShutter()).toBe(true);
    expect(m.takeShutter()).toBe(false); // consumed
    expect(m.frame(fr(200, null), true)).toEqual([{ t: "miss" }]);
  });

  it("an unresolved outcome after a suggestion pauses 2 s", () => {
    const s = new VoteSession();
    suggest(s);
    s.outcome(
      { t: "lockOutcome", lockId: 1, added: false, reason: "unresolved" },
      300
    );
    expect(s.state).toBe("cooldown");
  });
});
