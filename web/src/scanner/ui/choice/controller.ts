// The Scan Choice's logic, with no React: resolve the versions, hold the one pending lock, and make sure each lock ends
// in exactly one `lockOutcome` (a direct add, a pick, None of these, or the card leaving the guide).
//
// A lock that needs no choice (one version with one active Edition) is added straight away. Any other lock opens the
// prompt: a `suggest` lock always does; an `auto` or `shutter` lock does when its card has look-alikes or more than one
// active Edition. Re-arming is the voter's: after any outcome it resets its absence run, so a card that left and came
// back before the outcome must leave the guide again before the next lock.
import type { ScannerPrinting } from "../../../scanner_generated";
import { variantLabel } from "../../../ui/variantLabel";
import type { LockResult } from "../../tray/store";
import type { LockVia, OutcomeReason } from "../../worker/messages";

export type ChoiceLock = {
  lockId: number;
  printingIds: string[];
  lookalikes: string[];
  via: LockVia;
};

/** What a choice can do. `resolve` is the tray store's `lookupPrintings`; `add` is its `applyChoice`; `answer` sends
 * the worker's `lockOutcome`; `settle` answers a result the way a lock's is answered (the `lockOutcome`, then the hint,
 * prompt or row cue); `openSearch` is None of these. */
export type ChoiceHost = {
  resolve(ids: string[]): Promise<ScannerPrinting[] | null>;
  add(
    printingId: string,
    editionId: string,
    candidates: string[]
  ): Promise<LockResult>;
  answer(lockId: number, added: boolean, reason?: OutcomeReason): void;
  settle(lockId: number, result: LockResult): void;
  openSearch(): void;
};

/** One version: its picture, and the set and number that tell reprints apart (plus the finish when it has only one).
 * No scores, no prices. `editions` are the active ones, in the catalog's order. */
export type Version = {
  printingId: string;
  name: string;
  setLine: string;
  image: string | null;
  editions: { id: string; label: string }[];
};
export type ChoiceView = {
  lockId: number;
  kind: "suggest" | "version" | "finish";
  versions: Version[];
};

export const MAX_VERSIONS = 8;

const unique = <T>(items: T[]): T[] => [...new Set(items)];

/** The ids a lock shows, in order. A suggestion lists the artwork matches after the look-alikes. */
export function versionIdsFor(lock: ChoiceLock): string[] {
  const [first, ...rest] = lock.printingIds;
  const ids =
    lock.via === "suggest"
      ? [first, ...lock.lookalikes, ...rest]
      : [first, ...lock.lookalikes];
  return unique(ids.filter((id) => id !== undefined)).slice(0, MAX_VERSIONS);
}

/** The versions in `ids` order that resolve with an active Edition; the others are left out silently. */
export function versionsFrom(
  ids: string[],
  printings: ScannerPrinting[]
): Version[] {
  const byId = new Map(printings.map((p) => [p.id, p]));
  const seen = new Set<string>();
  const out: Version[] = [];
  for (const id of ids) {
    const p = byId.get(id);
    if (seen.has(id) || !p) continue;
    const editions = p.editions
      .filter((e) => e.active)
      .map((e) => ({ id: e.id, label: variantLabel(e.descriptor) }));
    if (editions.length === 0) continue;
    seen.add(id);
    out.push({
      printingId: id,
      name: p.name,
      setLine: `${p.set_name} ${p.collector_number}`,
      image: p.art_url,
      editions,
    });
  }
  return out;
}

type Pending = {
  lock: ChoiceLock;
  host: ChoiceHost;
  /** Its outcome has been sent (or is being made): nothing else may answer it. */
  done: boolean;
  /** The prompt is on screen. */
  shown: boolean;
  /** The card left the guide while an auto or shutter lock was still resolving. */
  absentSeen: boolean;
};

export function createChoices() {
  let view: ChoiceView | null = null;
  let pending: Pending | null = null;
  const listeners = new Set<() => void>();
  const show = (next: ChoiceView | null) => {
    view = next;
    for (const l of [...listeners]) l();
  };
  /** Ends the pending lock: from here only the caller answers it. */
  const take = (): Pending | null => {
    const p = pending;
    if (!p || p.done) return null;
    p.done = true;
    pending = null;
    show(null);
    return p;
  };
  const addSafely = async (
    host: ChoiceHost,
    printingId: string,
    editionId: string,
    candidates: string[]
  ): Promise<LockResult> => {
    try {
      return await host.add(printingId, editionId, candidates);
    } catch {
      return { added: false, reason: "offline" };
    }
  };

  return {
    getView: () => view,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    async onLock(lock: ChoiceLock, host: ChoiceHost): Promise<void> {
      // The worker makes no new lock before an outcome, so this is a guard, not a path.
      const old = take();
      old?.host.answer(old.lock.lockId, false, "dismissed");
      const mine: Pending = {
        lock,
        host,
        done: false,
        shown: false,
        absentSeen: false,
      };
      pending = mine;
      const found = await host.resolve(
        unique([...lock.printingIds, ...lock.lookalikes])
      );
      if (mine.done) return; // the card left or a newer lock replaced this one: already answered
      if (found === null) {
        take();
        host.settle(lock.lockId, { added: false, reason: "offline" });
        return;
      }
      let versions = versionsFrom(versionIdsFor(lock), found);
      if (
        lock.via !== "suggest" &&
        !versions.some((v) => v.printingId === lock.printingIds[0])
      ) {
        // The best match does not resolve: the next candidate that does stands alone, with no look-alikes.
        const next = versionsFrom(lock.printingIds.slice(1), found)[0];
        versions = next ? [next] : [];
      }
      if (versions.length === 0) {
        take();
        host.settle(lock.lockId, { added: false, reason: "unresolved" });
        return;
      }
      const kind: ChoiceView["kind"] | null =
        lock.via === "suggest"
          ? "suggest"
          : versions.length > 1
            ? "version"
            : versions[0].editions.length > 1
              ? "finish"
              : null;
      if (kind === null) {
        // A direct add is never skipped by the card leaving: take it first so no `absent` or `none` can answer it.
        if (!take()) return;
        const v = versions[0];
        const result = await addSafely(
          host,
          v.printingId,
          v.editions[0].id,
          lock.printingIds.filter((id) => id !== v.printingId)
        );
        host.settle(lock.lockId, result);
        return;
      }
      if (mine.absentSeen) {
        take();
        host.answer(lock.lockId, false, "dismissed");
        return;
      }
      mine.shown = true;
      show({ lockId: lock.lockId, kind, versions });
    },

    /** The collector picked a version and finish: one copy of that Printing and Edition is added. */
    async pick(
      lockId: number,
      printingId: string,
      editionId: string
    ): Promise<void> {
      if (pending?.lock.lockId !== lockId) return;
      const p = take();
      if (!p) return;
      const others = unique([
        ...p.lock.printingIds,
        ...p.lock.lookalikes,
      ]).filter((id) => id !== printingId);
      const result = await addSafely(p.host, printingId, editionId, others);
      p.host.settle(p.lock.lockId, result);
    },

    /** None of these: dismissed, and search opens. */
    none(lockId: number): void {
      if (pending?.lock.lockId !== lockId) return;
      const p = take();
      if (!p) return;
      p.host.answer(p.lock.lockId, false, "dismissed");
      p.host.openSearch();
    },

    /** The scanner session ended or restarted: the pending lock is dismissed once, and its late lookup shows nothing.
     * The session it came from may already be gone, so a failing answer is ignored. */
    reset(): void {
      const p = take();
      if (!p) return;
      try {
        p.host.answer(p.lock.lockId, false, "dismissed");
      } catch {
        // the session is disposed: nothing is waiting for the outcome
      }
    },

    /** The worker says the card left the guide: a prompt closes unanswered by the collector; a lock still resolving
     * is skipped once it would prompt. A direct add that has begun is never skipped. */
    absent(lockId: number): void {
      if (!pending || pending.lock.lockId !== lockId) return;
      if (pending.lock.via === "suggest" || pending.shown) {
        const p = take();
        p?.host.answer(lockId, false, "dismissed");
        return;
      }
      pending.absentSeen = true;
    },
  };
}

export type Choices = ReturnType<typeof createChoices>;
