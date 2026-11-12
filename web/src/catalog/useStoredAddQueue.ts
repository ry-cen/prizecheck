import { createContext, useContext, useEffect, useRef, useState } from "react";
import { browseEditions } from "../catalog_browse_generated";
import { getLocationTree } from "../location_generated";
import { EMPTY_QUEUE, minus, without, type AddQueue } from "./addQueue";
import {
  outcomeKind,
  type AddItem,
  type AddOutcome,
  type AddCommand,
} from "./cardActions";
import { MAX_ADD, MAX_BATCH_EDITIONS } from "./catalogText";

export const AddQueueAccount = createContext<string | null>(null);
const PREFIX = "prizecheck:add-queue:";
type Draft = {
  items: { editionId: string; printingId: string; quantity: number }[];
  target: string | null;
  uncertain: boolean;
  /** An abandoned or unresolvable Add, independently acknowledged by Dismiss. */
  unresolved?: boolean;
  pending?: AddCommand | null;
};
const empty = (): Draft => ({ items: [], target: null, uncertain: false });
export function forgetAddQueues(account: string | null = null) {
  try {
    for (const key of Object.keys(sessionStorage))
      if (
        key.startsWith(PREFIX) &&
        (!account || !key.startsWith(PREFIX + account + ":"))
      )
        sessionStorage.removeItem(key);
  } catch {
    /* Storage off: the queue remains usable in memory. */
  }
}
function read(key: string): Draft {
  try {
    const raw: unknown = JSON.parse(sessionStorage.getItem(key) ?? "null");
    if (!raw || typeof raw !== "object") throw Error();
    const d = raw as Draft;
    if (
      !Array.isArray(d.items) ||
      d.items.length > MAX_BATCH_EDITIONS ||
      typeof d.uncertain !== "boolean" ||
      (d.unresolved !== undefined && typeof d.unresolved !== "boolean") ||
      (d.target !== null && typeof d.target !== "string") ||
      !d.items.every(
        (i) =>
          typeof i.editionId === "string" &&
          typeof i.printingId === "string" &&
          Number.isInteger(i.quantity) &&
          i.quantity > 0 &&
          i.quantity <= MAX_ADD
      ) ||
      new Set(d.items.map((i) => i.editionId)).size !== d.items.length
    )
      throw Error();
    if (
      d.pending !== undefined &&
      d.pending !== null &&
      (typeof d.pending !== "object" ||
        Array.isArray(d.pending) ||
        typeof d.pending.key !== "string" ||
        !d.pending.key ||
        typeof d.pending.locationId !== "string" ||
        !d.pending.locationId ||
        typeof d.pending.path !== "string" ||
        !Array.isArray(d.pending.items) ||
        !d.pending.items.length ||
        d.pending.items.length > MAX_BATCH_EDITIONS ||
        !d.pending.items.every(
          (i) =>
            typeof i.editionId === "string" &&
            i.editionId.length > 0 &&
            Number.isInteger(i.quantity) &&
            i.quantity > 0 &&
            i.quantity <= MAX_ADD
        ) ||
        new Set(d.pending.items.map((i) => i.editionId)).size !==
          d.pending.items.length)
    )
      throw Error();
    return d;
  } catch {
    try {
      sessionStorage.removeItem(key);
    } catch {
      /* Storage off. */
    }
    return empty();
  }
}

/** Only this account and gallery scope may influence the initial mode. */
export function hasStoredAddQueue(
  account: string | null,
  scope: string
): boolean {
  if (!account) return false;
  const draft = read(PREFIX + account + ":" + scope);
  return draft.items.length > 0 || draft.uncertain;
}

type State = {
  pending: { current: AddCommand | null };
  phase: "restoring" | "failed" | "ready";
  draft: Draft;
  queue: AddQueue;
  chosen: string | null;
  restoredMarker: boolean;
  current: AddItem[];
  lost: AddItem[];
  open: boolean;
  lostEarlier: boolean;
  notice: string;
};
function initial(draft = empty()): State {
  return {
    pending: { current: draft.pending ?? null },
    phase: "restoring",
    draft,
    queue: EMPTY_QUEUE,
    chosen: null,
    restoredMarker: draft.unresolved ?? (draft.uncertain && !draft.pending),
    current: [],
    lost: [],
    open: false,
    lostEarlier: false,
    notice: "",
  };
}
function cap(items: readonly AddItem[], queue: AddQueue): AddItem[] {
  return items.flatMap((item) => {
    const quantity = Math.min(
      item.quantity,
      queue.get(item.editionId)?.count ?? 0
    );
    return quantity > 0 ? [{ editionId: item.editionId, quantity }] : [];
  });
}
function maxEach(a: readonly AddItem[], b: readonly AddItem[]): AddItem[] {
  const counts = new Map<string, number>();
  for (const item of [...a, ...b])
    counts.set(
      item.editionId,
      Math.max(counts.get(item.editionId) ?? 0, item.quantity)
    );
  return Array.from(counts, ([editionId, quantity]) => ({
    editionId,
    quantity,
  }));
}
function record(s: State): Draft | null {
  const uncertain = s.restoredMarker || s.open || s.lostEarlier;
  // A replayable command must never hide an unrelated warning. Legacy submissions
  // without a command can only retain a warning, since they cannot be replayed.
  const unresolved =
    s.restoredMarker || s.lostEarlier || (s.open && !s.pending.current);
  const items =
    s.phase !== "ready"
      ? s.draft.items
      : Array.from(
          minus(
            s.queue,
            s.pending.current ? s.lost : maxEach(s.current, s.lost)
          ).values(),
          ({ edition, count }) => ({
            editionId: edition.edition_id,
            printingId: edition.printing_id,
            quantity: count,
          })
        );
  const target = s.phase !== "ready" ? s.draft.target : s.chosen;
  return items.length || uncertain || s.pending.current
    ? { items, target, uncertain, unresolved, pending: s.pending.current }
    : null;
}

/** Held current and lost copies are capped to the visible queue after every queue change (I1).
 * Storage retains the visible queue and immutable replay command; legacy submissions without a command retain only their uncertainty marker. */
export function useStoredAddQueue(scope: string) {
  const account = useContext(AddQueueAccount);
  const key = account ? PREFIX + account + ":" + scope : null;
  const s = useRef<State>(initial());
  const [view, render] = useState(s.current);
  const mounted = useRef(false);
  const epochRef = useRef({});
  const lastKey = useRef(key);
  if (lastKey.current !== key) {
    lastKey.current = key;
    epochRef.current = {};
  }
  const epoch = epochRef.current;
  const liveOwner = () => mounted.current && epochRef.current === epoch;
  const restoration = useRef(0);
  function persist() {
    if (!key || !liveOwner()) return;
    const draft = record(s.current);
    try {
      if (draft) sessionStorage.setItem(key, JSON.stringify(draft));
      else sessionStorage.removeItem(key);
    } catch {
      try {
        sessionStorage.removeItem(key);
      } catch {
        /* Storage off. */
      }
    }
  }
  const revision = useRef(0);
  function publish() {
    ++revision.current;
    render({ ...s.current });
    persist();
  }
  function capHeld() {
    s.current.current = cap(s.current.current, s.current.queue);
    s.current.lost = cap(s.current.lost, s.current.queue);
  }
  useEffect(() => {
    mounted.current = true;
    let live = true;
    const restoreId = ++restoration.current;
    forgetAddQueues(account);
    s.current = initial(key ? read(key) : empty());
    render({ ...s.current });
    const draft = s.current.draft;
    async function restore() {
      try {
        const tree = draft.target ? await getLocationTree() : null;
        const target = tree?.locations.some(
          (l) =>
            l.id === draft.target &&
            (l.kind === "storage_leaf" || l.kind === "deck")
        )
          ? draft.target
          : null;
        const queue: AddQueue = new Map(
          (
            await Promise.all(
              draft.items.map(async (item) => {
                let cursor: string | null = null;
                do {
                  const page = await browseEditions(
                    { printing_id: item.printingId },
                    cursor
                  );
                  if (!page.available) throw Error();
                  const edition = page.editions.find(
                    (e) => e.edition_id === item.editionId
                  );
                  if (edition)
                    return [
                      item.editionId,
                      { edition, count: item.quantity },
                    ] as const;
                  cursor = page.next_cursor;
                } while (cursor);
                return null;
              })
            )
          ).filter((item) => item !== null)
        );
        if (!live || !liveOwner() || restoration.current !== restoreId) return;
        s.current.queue = queue;
        s.current.chosen = target ?? (draft.pending ? draft.target : null);
        s.current.phase = "ready";
        if (queue.size !== draft.items.length || (draft.target && !target))
          s.current.notice =
            "Some queued cards or the Location are no longer available.";
        publish();
      } catch {
        if (!live || !liveOwner() || restoration.current !== restoreId) return;
        s.current.phase = "failed";
        s.current.notice = "Couldn't restore your queue. Reload to try again.";
        render({ ...s.current });
      }
    }
    void restore();
    return () => {
      live = false;
      mounted.current = false;
    };
  }, [key, account]);
  return {
    pending: view.pending,
    blocked: view.lost.length > 0,
    queue: view.queue,
    chosen: view.chosen,
    uncertain: view.restoredMarker || view.lostEarlier,
    ready: view.phase === "ready",
    notice: view.notice,
    restoreFailed: view.phase === "failed",
    setQueue(f: (q: AddQueue) => AddQueue) {
      if (!liveOwner() || s.current.phase !== "ready") return;
      s.current.queue = f(s.current.queue);
      capHeld();
      publish();
    },
    setChosen(id: string) {
      if (!liveOwner() || s.current.phase !== "ready") return;
      s.current.chosen = id;
      publish();
    },
    submitting(items: readonly AddItem[], command?: AddCommand) {
      if (!liveOwner()) return;
      if (command) s.current.pending.current = structuredClone(command);
      s.current.current = cap(items, s.current.queue);
      s.current.open = true;
      publish();
    },
    settle(o: AddOutcome) {
      if (!liveOwner()) return;
      const kind = outcomeKind(o);
      if (o.ok || kind === "refused" || kind === "lost")
        s.current.pending.current = null;
      if (o.ok) {
        s.current.queue = minus(s.current.queue, o.items);
        s.current.current = [];
        s.current.open = false;
        capHeld();
      } else if (kind === "refused") {
        s.current.current = [];
        s.current.open = false;
        if (o.code === "EDITION_UNAVAILABLE" && o.editionId)
          s.current.queue = without(s.current.queue, o.editionId);
        capHeld();
      } else if (kind === "lost") {
        s.current.lost = maxEach(s.current.lost, s.current.current);
        s.current.current = [];
        s.current.open = false;
        s.current.lostEarlier = true;
      }
      publish();
    },
    /** Recovery is local only; uncertain submissions retain the existing Discard behavior. */
    clearUndo(): (() => boolean) | null {
      if (!liveOwner() || s.current.phase !== "ready") return null;
      const before = s.current;
      const recoverable =
        !before.pending.current &&
        !before.open &&
        !before.restoredMarker &&
        !before.lostEarlier &&
        !before.lost.length;
      const saved = { queue: before.queue, chosen: before.chosen };
      this.clear();
      if (!recoverable || !saved.queue.size) return null;
      const version = revision.current;
      return () => {
        if (!liveOwner() || revision.current !== version) return false;
        s.current.queue = saved.queue;
        s.current.chosen = saved.chosen;
        publish();
        return true;
      };
    },
    clear() {
      if (!liveOwner()) return;
      ++restoration.current;
      // Discard explicitly abandons replay, but cannot prove the earlier Add never committed.
      if (s.current.pending.current) {
        s.current.pending.current = null;
        s.current.restoredMarker = true;
        s.current.open = false;
      }
      s.current.phase = "ready";
      s.current.notice = "";
      s.current.queue = EMPTY_QUEUE;
      capHeld();
      publish();
    },
    dismiss() {
      if (!liveOwner()) return;
      s.current.restoredMarker = false;
      s.current.lostEarlier = false;
      publish();
    },
  };
}
