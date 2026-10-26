// The Scan Suggestion's logic, with no React: resolve the candidates, hold the one pending suggestion, and make sure
// each `suggest` lock ends in exactly one `lockOutcome` (a pick, None of these, or the card leaving the guide).
import {
  resolveScannerPrintings,
  type ScannerPrinting,
} from "../../../scanner_generated";
import { PRINTINGS_TIMEOUT_MS, type LockResult } from "../../tray/store";
import type { OutcomeReason } from "../../worker/messages";

export type SuggestLock = { lockId: number; printingIds: string[] };

/** What a suggestion can do. `answer` sends the worker's `lockOutcome`; `pick` is `applyPick` of the tray store;
 * `settle` answers a result the way a lock's is answered (the `lockOutcome`, then the hint, prompt or row cue);
 * `openSearch` is None of these. */
export type SuggestionHost = {
  answer(lockId: number, added: boolean, reason?: OutcomeReason): void;
  pick(printingId: string, others: string[]): Promise<LockResult>;
  settle(lockId: number, result: LockResult): void;
  openSearch(): void;
};

/** One candidate: its picture and the set and number that tell reprints apart. No scores, no prices. */
export type Candidate = {
  printingId: string;
  name: string;
  setLine: string;
  image: string | null;
};
export type SuggestionView = { lockId: number; candidates: Candidate[] };

/** The printings of `ids`, or null when the route cannot be reached. */
export type ResolvePrintings = (
  ids: string[]
) => Promise<ScannerPrinting[] | null>;

export const resolveCandidates: ResolvePrintings = async (ids) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const answer = await Promise.race([
      resolveScannerPrintings(ids),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("timeout")),
          PRINTINGS_TIMEOUT_MS
        );
      }),
    ]);
    return answer.printings;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

/** The candidates in the worker's order that resolve with an active Edition; the others are left out silently. */
export function candidatesFrom(
  ids: string[],
  printings: ScannerPrinting[]
): Candidate[] {
  const byId = new Map(printings.map((p) => [p.id, p]));
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const id of ids.slice(0, 3)) {
    const p = byId.get(id);
    if (seen.has(id) || !p?.default_edition_id) continue;
    seen.add(id);
    out.push({
      printingId: id,
      name: p.name,
      setLine: `${p.set_name} ${p.collector_number}`,
      image: p.low_image_url,
    });
  }
  return out;
}

type Pending = {
  lock: SuggestLock;
  host: SuggestionHost;
  /** Its outcome has been sent (or is being made): nothing else may answer it. */
  done: boolean;
};

export function createSuggestions(
  resolve: ResolvePrintings = resolveCandidates
) {
  let view: SuggestionView | null = null;
  let pending: Pending | null = null;
  const listeners = new Set<() => void>();
  const show = (next: SuggestionView | null) => {
    view = next;
    for (const l of [...listeners]) l();
  };
  /** Ends the pending suggestion: from here only the caller answers it. */
  const take = (): Pending | null => {
    const p = pending;
    if (!p || p.done) return null;
    p.done = true;
    pending = null;
    show(null);
    return p;
  };

  return {
    getView: () => view,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    async onSuggest(lock: SuggestLock, host: SuggestionHost): Promise<void> {
      // The worker makes no new lock before an outcome, so this is a guard, not a path.
      const old = take();
      old?.host.answer(old.lock.lockId, false, "dismissed");
      const mine: Pending = { lock, host, done: false };
      pending = mine;
      const found = await resolve(lock.printingIds);
      if (mine.done) return; // the card left while the route was answering: already dismissed
      if (found === null) {
        take();
        host.settle(lock.lockId, { added: false, reason: "offline" });
        return;
      }
      const candidates = candidatesFrom(lock.printingIds, found);
      if (candidates.length === 0) {
        take();
        host.settle(lock.lockId, { added: false, reason: "unresolved" });
        return;
      }
      show({ lockId: lock.lockId, candidates });
    },

    /** The collector picked a candidate: it is added as a lock of that Printing would be. */
    async pick(printingId: string): Promise<void> {
      const p = take();
      if (!p) return;
      const others = p.lock.printingIds.filter((id) => id !== printingId);
      let result: LockResult;
      try {
        result = await p.host.pick(printingId, others);
      } catch {
        result = { added: false, reason: "offline" };
      }
      p.host.settle(p.lock.lockId, result);
    },

    /** None of these: dismissed, and search opens. */
    none(): void {
      const p = take();
      if (!p) return;
      p.host.answer(p.lock.lockId, false, "dismissed");
      p.host.openSearch();
    },

    /** The worker says the card left the guide: the suggestion closes unanswered by the collector. */
    absent(lockId: number): void {
      if (!pending || pending.lock.lockId !== lockId) return;
      const p = take();
      p?.host.answer(lockId, false, "dismissed");
    },
  };
}

export type Suggestions = ReturnType<typeof createSuggestions>;
