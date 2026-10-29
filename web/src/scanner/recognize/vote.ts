// Frame voting: the resolution's "Frame voting and capture" rule plus the brief's D-H3 (absence runs on every frame).
// `state` has no time argument, so "cooldown" is judged against the latest timestamp the voter has seen
// (onFrame, onShutter, onShutterFrame or onOutcome).
import type { LockVia, OutcomeReason } from "../worker/messages";
import { VOTE } from "./constants";
import { cmpStr } from "./types";
import type { VoteConfig, VoteState } from "./types";

export type { LockVia };

export type VoteFrame = {
  t: number;
  thumb: Uint8Array;
  top: readonly string[] | null;
  eligible: boolean;
  textBacked: boolean;
  /** The ids whose printed-number reading supports them at least as strongly as top[0] (empty unless textBacked). */
  numberIds: readonly string[];
};
// top null: the full pipeline did not run. eligible: a card is evidently present (quad found or OCR candidates), so the frame may count toward an automatic lock.
// textBacked: top[0] is one of the frame's OCR catalog candidates (the printed number agrees), not an image-only pick.
export type VoteEvent =
  | {
      kind: "lock";
      lockId: number;
      printingIds: string[];
      via: LockVia;
      /** Automatic locks: the union of the backing frames' number ids; the look-alikes are narrowed to these. null: no narrowing. */
      numberIds: string[] | null;
    }
  | { kind: "miss" };

/** Mean |a - b| in 0..255 units. */
export function thumbMad(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let s = 0;
  for (let i = 0; i < n; i++) s += Math.abs(a[i] - b[i]);
  return s / n;
}

/** Rank r (0-based, within top.slice(0, 10)) scores base - r. Order by score descending, then id ascending. */
export function bordaOrder(
  window: readonly { top: readonly string[] }[],
  base: number = VOTE.bordaBase
): string[] {
  const score = new Map<string, number>();
  for (const w of window) {
    const top = w.top.slice(0, 10);
    for (let r = 0; r < top.length; r++)
      score.set(top[r], (score.get(top[r]) ?? 0) + base - r);
  }
  return [...score.keys()].sort(
    (a, b) =>
      (score.get(b) as number) - (score.get(a) as number) || cmpStr(a, b)
  );
}

// LockVia. auto: frames agree and the printed number backs the pick. suggest: frames agree on the image alone, so the collector
// confirms it (owner, 2026-10-23: image-only auto locks were wrong 6 of 9 times on the phone). shutter: the collector pressed the shutter.

type Entry = {
  t: number;
  top: readonly string[];
  textBacked: boolean;
  numberIds: readonly string[];
};

export class Voter {
  private readonly cfg: VoteConfig;
  private st: "armed" | "pending" | "locked" = "armed";
  private window: Entry[] = [];
  private lockId = 0;
  private lockThumb: Uint8Array | null = null;
  private lastThumb: Uint8Array | null = null;
  private absentRun = 0;
  private absentPosted = false;
  private noLockUntil = -Infinity;
  private now = -Infinity;

  constructor(cfg: VoteConfig = VOTE) {
    this.cfg = cfg;
  }

  get state(): VoteState {
    if (this.st === "armed" && this.now < this.noLockUntil) return "cooldown";
    return this.st;
  }

  private seen(t: number): void {
    if (t > this.now) this.now = t;
  }

  private lock(
    ids: string[],
    thumb: Uint8Array | null,
    via: LockVia,
    numberIds: string[] | null = null
  ): VoteEvent {
    this.lockId += 1;
    this.lockThumb = thumb;
    this.absentRun = 0;
    this.absentPosted = false;
    this.st = "pending";
    return {
      kind: "lock",
      lockId: this.lockId,
      printingIds: ids,
      via,
      numberIds,
    };
  }

  /** `absence`: a locked voter re-armed. `absentLockId`: the card left the guide while a lock waits for its outcome (once per lock, whatever its `via`). */
  onFrame(f: VoteFrame): {
    event: VoteEvent | null;
    absence: boolean;
    mad: number | null;
    absentLockId: number | null;
  } {
    this.seen(f.t);
    this.lastThumb = f.thumb;
    if (this.st === "pending") {
      // A pending lock keeps tracking absence (same thumbnail rule as after a lock) so the main thread can skip a choice the card left.
      if (this.absentPosted)
        return { event: null, absence: false, mad: null, absentLockId: null };
      const mad = this.lockThumb ? thumbMad(f.thumb, this.lockThumb) : 0;
      if (mad > this.cfg.absenceMad) this.absentRun += 1;
      else this.absentRun = 0;
      if (this.absentRun < this.cfg.absenceFrames)
        return { event: null, absence: false, mad, absentLockId: null };
      this.absentPosted = true;
      return { event: null, absence: false, mad, absentLockId: this.lockId };
    }
    if (this.st === "locked") {
      const mad = this.lockThumb ? thumbMad(f.thumb, this.lockThumb) : 0;
      if (mad > this.cfg.absenceMad) this.absentRun += 1;
      else this.absentRun = 0;
      if (this.absentRun >= this.cfg.absenceFrames) {
        this.st = "armed";
        this.window = [];
        this.absentRun = 0;
        return { event: null, absence: true, mad, absentLockId: null };
      }
      return { event: null, absence: false, mad, absentLockId: null };
    }
    // armed (cooldown included)
    this.window = this.window.filter((w) => w.t >= f.t - this.cfg.windowMs);
    if (f.top !== null && f.eligible) {
      this.window.push({
        t: f.t,
        top: f.top,
        textBacked: f.textBacked,
        numberIds: f.numberIds,
      });
      if (this.window.length > this.cfg.windowFrames)
        this.window = this.window.slice(-this.cfg.windowFrames);
    }
    if (f.t >= this.noLockUntil) {
      const counts = new Map<string, number>();
      for (const w of this.window) {
        if (w.top.length > 0)
          counts.set(w.top[0], (counts.get(w.top[0]) ?? 0) + 1);
      }
      for (const [id, n] of counts) {
        if (n >= this.cfg.need) {
          const rest = bordaOrder(this.window)
            .filter((x) => x !== id)
            .slice(0, 2);
          const backing = this.window.filter(
            (w) => w.textBacked && w.top[0] === id
          );
          const backed = backing.length > 0;
          const numberIds = backed
            ? [...new Set(backing.flatMap((w) => w.numberIds))]
            : null;
          return {
            event: this.lock(
              [id, ...rest],
              f.thumb,
              backed ? "auto" : "suggest",
              numberIds
            ),
            absence: false,
            mad: null,
            absentLockId: null,
          };
        }
      }
    }
    return { event: null, absence: false, mad: null, absentLockId: null };
  }

  onShutter(t: number): VoteEvent | "needFrame" | null {
    this.seen(t);
    if (this.st === "pending") return null;
    const newest =
      this.window.length > 0 ? this.window[this.window.length - 1] : null;
    if (newest !== null && newest.t >= t - this.cfg.shutterFreshMs) {
      const order = bordaOrder(this.window);
      if (order.length > 0)
        return this.lock(order.slice(0, 3), this.lastThumb, "shutter");
    }
    return "needFrame";
  }

  /** null: a lock or suggestion is pending (the shutter does nothing). */
  onShutterFrame(f: VoteFrame): VoteEvent | null {
    this.seen(f.t);
    this.lastThumb = f.thumb;
    if (this.st === "pending") return null;
    if (f.top === null || f.top.length === 0) return { kind: "miss" };
    return this.lock(f.top.slice(0, 3), f.thumb, "shutter");
  }

  /** dismissed: the collector turned a suggestion down (and searched instead); like an add, the card must leave the guide before the next lock. */
  onOutcome(
    lockId: number,
    added: boolean,
    reason: OutcomeReason | undefined,
    t: number
  ): void {
    this.seen(t);
    if (this.st !== "pending" || lockId !== this.lockId) return;
    if (added || reason === "full" || reason === "dismissed") {
      this.st = "locked";
      this.absentRun = 0;
    } else {
      this.st = "armed";
      this.window = [];
      this.noLockUntil = t + this.cfg.failPauseMs;
    }
  }
}
