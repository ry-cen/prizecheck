// The hint pill: what the camera or a lock outcome tells the collector. Pure, so it is tested without a browser.
import { GATE } from "../vision/gate";
import type { GateReason } from "../worker/messages";
import {
  HINT_BRIGHT,
  HINT_DARK,
  HINT_EDITION_LIMIT,
  HINT_GLARE,
  HINT_OFFLINE,
  HINT_SOFT,
  HINT_UNRESOLVED,
} from "./copy";

/** The sharpness check is off in the shipped gate (spec "Recognition decided by the primary"), so "Hold steady" waits. */
export const SHARPNESS_ON = GATE.sharpMin > 0;

export function gateHint(
  reason: GateReason,
  sharpnessOn: boolean = SHARPNESS_ON
): string | null {
  switch (reason) {
    case "dark":
      return HINT_DARK;
    case "bright":
      return HINT_BRIGHT;
    case "clipped":
      return HINT_GLARE;
    case "soft":
      return sharpnessOn ? HINT_SOFT : null;
  }
}

export type OutcomeHint = "unresolved" | "offline" | "edition_limit";
export function outcomeHint(kind: OutcomeHint): string {
  return kind === "unresolved"
    ? HINT_UNRESOLVED
    : kind === "offline"
      ? HINT_OFFLINE
      : HINT_EDITION_LIMIT;
}

/** A gate verdict counts after this many frames in a row, so a flickering frame does not flash the pill. */
export const GATE_STABLE_FRAMES = 2;

export type GateTracker = {
  shown: GateReason | null;
  run: number;
  seen: GateReason | "ok" | null;
};
export const newGateTracker = (): GateTracker => ({
  shown: null,
  run: 0,
  seen: null,
});

/** Folds one `gate` message in. The same object comes back when nothing changed, so a steady camera re-renders nothing. */
export function trackGate(
  t: GateTracker,
  ok: boolean,
  reason: GateReason | undefined
): GateTracker {
  const seen: GateReason | "ok" = ok ? "ok" : (reason ?? "ok");
  const run = Math.min(seen === t.seen ? t.run + 1 : 1, GATE_STABLE_FRAMES);
  const shown =
    run < GATE_STABLE_FRAMES ? t.shown : seen === "ok" ? null : seen;
  if (seen === t.seen && run === t.run && shown === t.shown) return t;
  return { seen, run, shown };
}
