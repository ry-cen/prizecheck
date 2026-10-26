// What a lock, a pick or a search pick tells the screen and the recognizer. Pure.
import type { EditResult, LockResult } from "../tray/store";
import type { LockVia, OutcomeReason } from "../worker/messages";
import type { OutcomeHint } from "./hints";

export type Reaction =
  | { kind: "added" }
  | { kind: "hint"; hint: OutcomeHint }
  /** The tray is full (a 201st Edition or a 401st row): the prompt opens and scanning pauses until it closes. */
  | { kind: "full-prompt" }
  /** A pending save freezes the tray: it opens so the collector can finish or retry. */
  | { kind: "open-tray" }
  /** A shutter whose candidates cannot be added opens search, as a miss does. */
  | { kind: "search" };

export type Outcome = {
  /** The worker's `lockOutcome`. */
  message: { added: boolean; reason?: OutcomeReason };
  reaction: Reaction;
};

export function reactToLock(result: LockResult, via: LockVia): Outcome {
  if (result.added)
    return { message: { added: true }, reaction: { kind: "added" } };
  const reason = result.reason ?? "unresolved";
  const message = { added: false, reason };
  if (reason === "offline")
    return { message, reaction: { kind: "hint", hint: "offline" } };
  if (reason === "full")
    return { message, reaction: capReaction(result.verdict) };
  // Unresolved: no candidate has an active Edition. A shutter goes to search; an automatic lock says so.
  return {
    message,
    reaction:
      via === "shutter"
        ? { kind: "search" }
        : { kind: "hint", hint: "unresolved" },
  };
}

/** The reaction to a refused edit (`full`, `row_limit`, `edition_limit`, `frozen`). */
export function capReaction(
  verdict: Exclude<EditResult, "ok"> | undefined
): Reaction {
  if (verdict === "edition_limit")
    return { kind: "hint", hint: "edition_limit" };
  if (verdict === "frozen") return { kind: "open-tray" };
  return { kind: "full-prompt" };
}

/**
 * Runs a store call that answers a lock (`applyLock`, `applyPick`). It can throw (storage over quota, a refused Web Lock);
 * the recognizer must still get its `lockOutcome` or its voter waits for one forever. A throw is an unresolved lock that
 * shows the hint, even for a shutter (search would find the same failure).
 */
export async function answerSafely(
  run: () => Promise<LockResult>,
  via: LockVia
): Promise<{ result: LockResult; via: LockVia }> {
  try {
    return { result: await run(), via };
  } catch {
    return {
      result: { added: false, reason: "unresolved" },
      via: via === "shutter" ? "auto" : via,
    };
  }
}
