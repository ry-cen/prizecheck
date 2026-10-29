import { describe, expect, it } from "vitest";
import { VOTE } from "./constants";
import { Voter, bordaOrder, thumbMad } from "./vote";
import type { VoteEvent, VoteFrame } from "./vote";

const SAME = new Uint8Array(1024).fill(100);
const ABSENT = new Uint8Array(1024).fill(200); // MAD 100 > 24
const fr = (
  t: number,
  top: string[] | null,
  thumb = SAME,
  eligible = true,
  textBacked = true,
  numberIds: string[] = []
): VoteFrame => ({ t, thumb, top, eligible, textBacked, numberIds });
const lockOf = (e: VoteEvent | null | "needFrame") => {
  if (e === null || e === "needFrame" || e.kind !== "lock")
    throw new Error(`expected lock, got ${JSON.stringify(e)}`);
  return e;
};

/** Feed three agreeing frames at t=0,100,200 and return the lock. */
function lockAuto(v: Voter, top = ["A", "B", "C"]) {
  v.onFrame(fr(0, top));
  v.onFrame(fr(100, top));
  return lockOf(v.onFrame(fr(200, top)).event);
}

describe("Voter", () => {
  it("image_only_agreement_suggests_instead_of_locking", () => {
    const v = new Voter();
    v.onFrame(fr(0, ["A", "B"], SAME, true, false));
    v.onFrame(fr(100, ["A", "B"], SAME, true, false));
    const e = lockOf(v.onFrame(fr(200, ["A", "B"], SAME, true, false)).event);
    expect(e.via).toBe("suggest");
    expect(e.printingIds[0]).toBe("A");
    expect(v.state).toBe("pending");
  });

  it("one_text_backed_frame_for_the_winner_makes_it_auto", () => {
    const v = new Voter();
    v.onFrame(fr(0, ["A"], SAME, true, false));
    v.onFrame(fr(100, ["A"], SAME, true, true));
    expect(lockOf(v.onFrame(fr(200, ["A"], SAME, true, false)).event).via).toBe(
      "auto"
    );
  });

  it("text_backing_for_another_printing_does_not_count", () => {
    const v = new Voter();
    v.onFrame(fr(0, ["B"], SAME, true, true));
    v.onFrame(fr(100, ["A"], SAME, true, false));
    v.onFrame(fr(200, ["A"], SAME, true, false));
    expect(lockOf(v.onFrame(fr(300, ["A"], SAME, true, false)).event).via).toBe(
      "suggest"
    );
  });

  it("dismissed_suggestion_waits_for_the_card_to_leave", () => {
    const v = new Voter();
    v.onFrame(fr(0, ["A"], SAME, true, false));
    v.onFrame(fr(100, ["A"], SAME, true, false));
    const e = lockOf(v.onFrame(fr(200, ["A"], SAME, true, false)).event);
    v.onOutcome(e.lockId, false, "dismissed", 250);
    expect(v.state).toBe("locked");
    expect(v.onFrame(fr(300, ["A"], SAME, true, false)).event).toBeNull();
    v.onFrame(fr(400, null, ABSENT));
    expect(v.onFrame(fr(500, null, ABSENT)).absence).toBe(true);
    expect(v.state).toBe("armed");
  });

  it("locks_at_3_of_4", () => {
    const v = new Voter();
    expect(v.onFrame(fr(0, ["A"])).event).toBeNull();
    expect(v.onFrame(fr(100, ["B"])).event).toBeNull();
    expect(v.onFrame(fr(200, ["A"])).event).toBeNull();
    const e = lockOf(v.onFrame(fr(300, ["A"])).event);
    expect(e.printingIds[0]).toBe("A");
    expect(e.via).toBe("auto");
    expect(e.lockId).toBe(1);
    expect(v.state).toBe("pending");
  });
  it("ineligible_frames_never_auto_lock", () => {
    const v = new Voter();
    for (let t = 0; t < 2000; t += 100)
      expect(v.onFrame(fr(t, ["A"], SAME, false)).event, `t=${t}`).toBeNull();
    expect(v.state).toBe("armed");
  });
  it("mixed_2_eligible_2_ineligible_does_not_lock", () => {
    const v = new Voter();
    for (const [t, el] of [
      [0, true],
      [100, false],
      [200, true],
      [300, false],
    ] as const)
      expect(v.onFrame(fr(t, ["A"], SAME, el)).event).toBeNull();
    expect(v.state).toBe("armed");
  });
  it("ineligible_frames_neither_add_to_nor_clear_the_window", () => {
    const v = new Voter();
    v.onFrame(fr(0, ["A"]));
    v.onFrame(fr(100, ["A"]));
    expect(v.onFrame(fr(150, ["B"], SAME, false)).event).toBeNull();
    lockOf(v.onFrame(fr(200, ["A"])).event);
  });
  it("shutter_frame_locks_even_when_ineligible", () => {
    const v = new Voter();
    const e = lockOf(v.onShutterFrame(fr(0, ["A", "B"], SAME, false)));
    expect(e.printingIds).toEqual(["A", "B"]);
    expect(e.via).toBe("shutter");
  });
  it("no_lock_with_2_of_4", () => {
    const v = new Voter();
    for (const [t, id] of [
      [0, "A"],
      [100, "B"],
      [200, "A"],
      [300, "C"],
    ] as const)
      expect(v.onFrame(fr(t, [id])).event).toBeNull();
    expect(v.state).toBe("armed");
  });
  it("window_drops_frames_older_than_2s", () => {
    const v = new Voter();
    v.onFrame(fr(0, ["A"]));
    v.onFrame(fr(100, ["A"]));
    expect(v.onFrame(fr(2500, ["A"])).event).toBeNull(); // the first two are older than 2 s
    expect(v.onFrame(fr(2600, ["A"])).event).toBeNull();
    lockOf(v.onFrame(fr(2700, ["A"])).event);
  });
  it("no_relock_without_absence", () => {
    const v = new Voter();
    const e = lockAuto(v);
    v.onOutcome(e.lockId, true, undefined, 250);
    expect(v.state).toBe("locked");
    for (let t = 300; t < 1500; t += 100)
      expect(v.onFrame(fr(t, ["A"])).event).toBeNull();
    expect(v.state).toBe("locked");
  });
  it("relock_after_two_absent_frames", () => {
    const v = new Voter();
    const e = lockAuto(v);
    v.onOutcome(e.lockId, true, undefined, 250);
    expect(v.onFrame(fr(300, ["A"], ABSENT)).absence).toBe(false);
    const r = v.onFrame(fr(400, ["A"], ABSENT));
    expect(r.absence).toBe(true);
    expect(r.mad).toBe(100);
    expect(v.state).toBe("armed");
    v.onFrame(fr(500, ["A"]));
    v.onFrame(fr(600, ["A"]));
    const e2 = lockOf(v.onFrame(fr(700, ["A"])).event);
    expect(e2.lockId).toBe(2);
  });
  it("gate_failing_frames_count_for_absence", () => {
    const v = new Voter();
    const e = lockAuto(v);
    v.onOutcome(e.lockId, true, undefined, 250);
    v.onFrame(fr(300, null, ABSENT));
    expect(v.onFrame(fr(400, null, ABSENT)).absence).toBe(true);
    expect(v.state).toBe("armed");
  });
  it("one_absent_frame_is_not_absence", () => {
    const v = new Voter();
    const e = lockAuto(v);
    v.onOutcome(e.lockId, true, undefined, 250);
    v.onFrame(fr(300, ["A"], ABSENT));
    expect(v.onFrame(fr(400, ["A"], SAME)).absence).toBe(false); // run resets
    expect(v.onFrame(fr(500, ["A"], ABSENT)).absence).toBe(false);
    expect(v.state).toBe("locked");
  });
  it("unresolved_outcome_pauses_2s_and_rearms_without_absence", () => {
    const v = new Voter();
    const e = lockAuto(v);
    v.onOutcome(e.lockId, false, "unresolved", 300);
    expect(v.state).toBe("cooldown");
    for (const t of [400, 500, 600, 2200])
      expect(v.onFrame(fr(t, ["A"])).event, `t=${t}`).toBeNull();
    // The cooldown ends at 2300; the window already holds 3 agreeing frames within 2 s.
    expect(v.state).toBe("cooldown");
    const r = v.onFrame(fr(2300, ["A"]));
    expect(lockOf(r.event).lockId).toBe(2);
  });
  it("full_outcome_requires_absence", () => {
    const v = new Voter();
    const e = lockAuto(v);
    v.onOutcome(e.lockId, false, "full", 300);
    expect(v.state).toBe("locked");
    expect(v.onFrame(fr(400, ["A"])).event).toBeNull();
    v.onFrame(fr(500, ["A"], ABSENT));
    expect(v.onFrame(fr(600, ["A"], ABSENT)).absence).toBe(true);
  });
  it("mismatched_lockId_ignored", () => {
    const v = new Voter();
    const e = lockAuto(v);
    v.onOutcome(e.lockId + 1, true, undefined, 250);
    expect(v.state).toBe("pending");
    v.onOutcome(e.lockId, true, undefined, 260);
    expect(v.state).toBe("locked");
    v.onOutcome(e.lockId, false, "unresolved", 270); // not pending: ignored
    expect(v.state).toBe("locked");
  });
  it("no_lock_while_pending", () => {
    const v = new Voter();
    lockAuto(v);
    for (let t = 300; t < 800; t += 100) {
      const r = v.onFrame(fr(t, ["A"]));
      expect(r.event).toBeNull();
      expect(r.absence).toBe(false);
    }
    expect(v.onShutter(900)).toBeNull();
    expect(v.state).toBe("pending");
  });
  it("shutter_borda_leader_when_fresh", () => {
    const v = new Voter();
    v.onFrame(fr(0, ["A", "B", "C"]));
    v.onFrame(fr(100, ["B", "A", "C"]));
    const e = lockOf(v.onShutter(600));
    expect(e.via).toBe("shutter");
    expect(e.printingIds).toEqual(["A", "B", "C"]); // A 10+9, B 9+10: tie by id
    expect(v.state).toBe("pending");
  });
  it("shutter_needFrame_when_stale_then_lock_top1", () => {
    const v = new Voter();
    v.onFrame(fr(0, ["A", "B"]));
    expect(v.onShutter(1500)).toBe("needFrame");
    const e = lockOf(v.onShutterFrame(fr(1500, ["Z", "Y", "X", "W"])));
    expect(e.printingIds).toEqual(["Z", "Y", "X"]);
    expect(e.via).toBe("shutter");
  });
  it("shutter_miss_on_empty", () => {
    const v = new Voter();
    expect(v.onShutterFrame(fr(100, []))).toEqual({ kind: "miss" });
    expect(v.onShutterFrame(fr(200, null))).toEqual({ kind: "miss" });
    expect(v.state).toBe("armed");
    expect(v.onShutter(300)).toBe("needFrame");
  });
  it("shutter ignores absence and cooldown", () => {
    const v = new Voter();
    const e = lockAuto(v);
    v.onOutcome(e.lockId, true, undefined, 250);
    expect(v.state).toBe("locked");
    expect(lockOf(v.onShutter(500)).via).toBe("shutter");
  });
  it("borda_ties_by_id", () => {
    expect(bordaOrder([{ top: ["b", "a"] }, { top: ["a", "b"] }])).toEqual([
      "a",
      "b",
    ]);
    expect(bordaOrder([{ top: ["z", "y"] }])).toEqual(["z", "y"]);
    expect(bordaOrder([{ top: ["a", "b"] }], 5)).toEqual(["a", "b"]);
    expect(bordaOrder([])).toEqual([]);
  });
  it("candidates_are_lock_then_next_two_by_borda", () => {
    const v = new Voter();
    v.onFrame(fr(0, ["A", "D", "E", "F"]));
    v.onFrame(fr(100, ["A", "E", "D", "F"]));
    const e = lockOf(v.onFrame(fr(200, ["A", "E", "G"])).event);
    // Borda: A 30, E 8+9+9=26, D 9+8=17, F 7+7=14, G 8
    expect(e.printingIds).toEqual(["A", "E", "D"]);
  });
  it("frames_with_neither_corners_nor_ocr_give_no_event", () => {
    const v = new Voter();
    for (let t = 0; t < 5000; t += 100) {
      const r = v.onFrame(fr(t, ["A", "B"], SAME, false, false));
      expect(r.event, `t=${t}`).toBeNull();
      expect(r.absentLockId).toBeNull();
    }
    expect(v.state).toBe("armed");
  });
  it("dismissed_has_no_2s_pause_but_needs_an_absence", () => {
    const v = new Voter();
    v.onFrame(fr(0, ["A"], SAME, true, false));
    v.onFrame(fr(100, ["A"], SAME, true, false));
    const e = lockOf(v.onFrame(fr(200, ["A"], SAME, true, false)).event);
    v.onOutcome(e.lockId, false, "dismissed", 250);
    expect(v.state).toBe("locked"); // not "cooldown"
    v.onFrame(fr(300, null, ABSENT));
    expect(v.onFrame(fr(400, null, ABSENT)).absence).toBe(true);
    expect(v.state).toBe("armed"); // armed at 400, 150 ms after the outcome: no pause
    v.onFrame(fr(500, ["B"], SAME, true, true));
    v.onFrame(fr(600, ["B"], SAME, true, true));
    expect(
      lockOf(v.onFrame(fr(700, ["B"], SAME, true, true)).event).printingIds[0]
    ).toBe("B");
  });
  it("unresolved_or_offline_after_a_suggestion_empties_the_window_and_rearms_after_2s", () => {
    for (const reason of ["unresolved", "offline"] as const) {
      const v = new Voter();
      v.onFrame(fr(0, ["A"], SAME, true, false));
      v.onFrame(fr(100, ["A"], SAME, true, false));
      const e = lockOf(v.onFrame(fr(200, ["A"], SAME, true, false)).event);
      expect(e.via).toBe("suggest");
      v.onOutcome(e.lockId, false, reason, 300);
      expect(v.state).toBe("cooldown");
      // The window was emptied: agreeing frames inside the pause cannot be reused, and none locks before 2300.
      for (const t of [400, 500, 600, 2200])
        expect(
          v.onFrame(fr(t, ["A"], SAME, true, false)).event,
          `${reason} t=${t}`
        ).toBeNull();
      const r = v.onFrame(fr(2300, ["A"], SAME, true, false));
      expect(lockOf(r.event).lockId).toBe(2);
    }
  });
  it("absent_fires_once_for_a_pending_suggestion", () => {
    const v = new Voter();
    v.onFrame(fr(0, ["A"], SAME, true, false));
    v.onFrame(fr(100, ["A"], SAME, true, false));
    const e = lockOf(v.onFrame(fr(200, ["A"], SAME, true, false)).event);
    expect(v.onFrame(fr(300, ["A"], SAME)).absentLockId).toBeNull(); // card still there
    expect(v.onFrame(fr(400, null, ABSENT)).absentLockId).toBeNull(); // one absent frame
    expect(v.onFrame(fr(500, ["A"], SAME)).absentLockId).toBeNull(); // run resets
    expect(v.onFrame(fr(600, null, ABSENT)).absentLockId).toBeNull();
    const r = v.onFrame(fr(700, null, ABSENT));
    expect(r.absentLockId).toBe(e.lockId);
    expect(r.event).toBeNull();
    expect(r.absence).toBe(false);
    expect(v.state).toBe("pending"); // the main thread still has to answer
    for (let t = 800; t < 1500; t += 100)
      expect(v.onFrame(fr(t, null, ABSENT)).absentLockId, `t=${t}`).toBeNull();
  });
  it("absent_fires_once_for_any_pending_lock", () => {
    const once = (v: Voter, lockId: number, from: number) => {
      const fired: (number | null)[] = [];
      for (let t = from; t < from + 800; t += 100)
        fired.push(v.onFrame(fr(t, null, ABSENT)).absentLockId);
      expect(fired.filter((x) => x !== null)).toEqual([lockId]);
    };
    const v = new Voter();
    once(v, lockAuto(v).lockId, 300);
    const w = new Voter();
    w.onFrame(fr(0, ["A"]));
    const shutter = lockOf(w.onShutter(50));
    expect(shutter.via).toBe("shutter");
    once(w, shutter.lockId, 100);
  });
  it("auto_lock_carries_the_number_ids_of_its_backing_frames", () => {
    const v = new Voter();
    v.onFrame(fr(0, ["A"], SAME, true, true, ["A", "X"]));
    v.onFrame(fr(100, ["A"], SAME, true, false, []));
    const e = lockOf(
      v.onFrame(fr(150, ["A"], SAME, true, true, ["A", "Y"])).event
    );
    expect(e.via).toBe("auto");
    expect(e.numberIds).toEqual(["A", "X", "Y"]);
  });
  it("suggest_and_shutter_locks_carry_null_number_ids", () => {
    const v = new Voter();
    v.onFrame(fr(0, ["A"], SAME, true, false, ["A"]));
    v.onFrame(fr(100, ["A"], SAME, true, false, ["A"]));
    const e = lockOf(v.onFrame(fr(200, ["A"], SAME, true, false, ["A"])).event);
    expect(e.via).toBe("suggest");
    expect(e.numberIds).toBeNull();
    const w = new Voter();
    w.onFrame(fr(0, ["A"], SAME, true, true, ["A"]));
    const s = lockOf(w.onShutter(50));
    expect(s.via).toBe("shutter");
    expect(s.numberIds).toBeNull();
  });
  it("absent_fires_again_for_the_next_suggestion", () => {
    const v = new Voter();
    const suggest = (t0: number) => {
      v.onFrame(fr(t0, ["A"], SAME, true, false));
      v.onFrame(fr(t0 + 100, ["A"], SAME, true, false));
      return lockOf(v.onFrame(fr(t0 + 200, ["A"], SAME, true, false)).event);
    };
    const e1 = suggest(0);
    v.onFrame(fr(300, null, ABSENT));
    expect(v.onFrame(fr(400, null, ABSENT)).absentLockId).toBe(e1.lockId);
    v.onOutcome(e1.lockId, false, "dismissed", 450);
    v.onFrame(fr(500, null, ABSENT));
    expect(v.onFrame(fr(600, null, ABSENT)).absence).toBe(true);
    const e2 = suggest(700);
    expect(e2.lockId).toBe(e1.lockId + 1);
    v.onFrame(fr(1000, null, ABSENT));
    expect(v.onFrame(fr(1100, null, ABSENT)).absentLockId).toBe(e2.lockId);
  });
  it("shutter_does_nothing_while_a_suggestion_is_pending", () => {
    const v = new Voter();
    v.onFrame(fr(0, ["A"], SAME, true, false));
    v.onFrame(fr(100, ["A"], SAME, true, false));
    lockOf(v.onFrame(fr(200, ["A"], SAME, true, false)).event);
    expect(v.onShutter(300)).toBeNull();
    expect(v.onShutterFrame(fr(400, ["B"]))).toBeNull();
    expect(v.onShutterFrame(fr(500, null))).toBeNull(); // no miss either
    expect(v.state).toBe("pending");
  });
  it("thumbMad is the mean absolute difference", () => {
    expect(
      thumbMad(new Uint8Array([0, 10, 20]), new Uint8Array([0, 20, 0]))
    ).toBeCloseTo(10, 9);
  });
  it("VOTE defaults", () => {
    expect(new Voter(VOTE).state).toBe("armed");
  });
});
