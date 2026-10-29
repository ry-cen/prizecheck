import { useEffect, useRef, useState, type RefObject } from "react";
import {
  getEditionPrices,
  MAX_PRICE_EDITIONS,
  PriceError,
  type PriceRow,
} from "./prices_generated";

// A price is a cached, server-validated enrichment. The rest of the page never waits for it: each slot asks
// for its own Edition once it comes near the viewport, the slots that come near together are batched (at most
// 64 ids each), and an answer that takes longer than the gateway budget becomes a labelled fallback instead of
// a spinner.
const CLIENT_TIMEOUT_MS = 3_500;
const BATCH_DELAY_MS = 15;
// Near is within two viewport heights of the visible area. The workspace gallery mounts rows one viewport beyond
// the window, so every tile it mounts still asks; a long catalog page asks only for the rows a collector is about
// to reach instead of queueing a refresh for every row at once (ADR 0013).
const NEAR_VIEWPORT = "200% 0px";

type Settled =
  { kind: "row"; row: PriceRow } | { kind: "timeout" } | { kind: "error" };
type Waiter = (settled: Settled) => void;

const MAX_IN_FLIGHT = 2;

const cache = new Map<string, PriceRow>();
const pending = new Map<string, Set<Waiter>>();

const waiting = new Map<string, Set<Waiter>>();
const queue: Array<Map<string, Set<Waiter>>> = [];
let inFlight = 0;
let scheduled: ReturnType<typeof setTimeout> | null = null;

// Batches wait here (never more than MAX_IN_FLIGHT on the wire); there is no polling and no retry.
function pump() {
  while (inFlight < MAX_IN_FLIGHT && queue.length) {
    const batch = queue.shift()!;
    for (const [id, set] of batch)
      if (!set.size) {
        batch.delete(id);
        pending.delete(id);
      } // unmounted while queued
    if (batch.size) send(batch);
  }
}

function send(waiters: Map<string, Set<Waiter>>) {
  const ids = [...waiters.keys()];
  const settle = (settled: (id: string) => Settled) => {
    for (const [id, set] of waiters) {
      const result = settled(id);
      if (result.kind === "row") cache.set(id, result.row);
      pending.delete(id);
      for (const waiter of set) waiter(result);
    }
  };
  inFlight += 1;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS);
  getEditionPrices(ids, controller.signal)
    .then((response) => {
      const rows = new Map(response.prices.map((row) => [row.edition_id, row]));
      settle((id) => {
        const row = rows.get(id);
        return row ? { kind: "row", row } : { kind: "error" };
      });
    })
    .catch((cause) => {
      const late =
        controller.signal.aborted ||
        (cause instanceof PriceError && cause.code === "PRICE_DEADLINE");
      settle(() => (late ? { kind: "timeout" } : { kind: "error" }));
    })
    .finally(() => {
      clearTimeout(timer);
      inFlight -= 1;
      pump();
    });
}

function flush() {
  scheduled = null;
  for (const [id, set] of waiting)
    if (!set.size) {
      waiting.delete(id);
      pending.delete(id);
    } // unmounted before the batch left
  while (waiting.size) {
    const batch = new Map<string, Set<Waiter>>();
    for (const [id, set] of waiting) {
      if (batch.size >= MAX_PRICE_EDITIONS) break;
      batch.set(id, set);
      waiting.delete(id);
    }
    queue.push(batch);
  }
  pump();
}

function request(editionId: string, waiter: Waiter) {
  const row = cache.get(editionId);
  if (row) {
    waiter({ kind: "row", row });
    return () => {};
  }
  let set = pending.get(editionId);
  if (!set) {
    set = new Set<Waiter>();
    pending.set(editionId, set);
    waiting.set(editionId, set);
    if (!scheduled) scheduled = setTimeout(flush, BATCH_DELAY_MS);
  }
  set.add(waiter);
  return () => {
    set.delete(waiter);
  };
}

// One observer for every slot, so the slots that come near in one frame are asked for in one batch.
const nearCallbacks = new Map<Element, () => void>();
let nearObserver: IntersectionObserver | null = null;

/** Calls `onNear` once, when `element` first comes near the viewport, or at once where IntersectionObserver
 * is missing. Returns a function that stops watching. */
function whenNear(element: Element | null, onNear: () => void): () => void {
  if (!element || typeof IntersectionObserver === "undefined") {
    onNear();
    return () => {};
  }
  nearObserver ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const callback = nearCallbacks.get(entry.target);
        nearCallbacks.delete(entry.target);
        nearObserver?.unobserve(entry.target);
        callback?.();
      }
    },
    { rootMargin: NEAR_VIEWPORT }
  );
  const observer = nearObserver;
  nearCallbacks.set(element, onNear);
  observer.observe(element);
  return () => {
    nearCallbacks.delete(element);
    observer.unobserve(element);
  };
}

/** A price slot's words: the amount alone, or a short state. It never shows $0 for a missing quote, and leaves out
 * the quote's source, age, last check and refresh state: the collector only needs the price. */
function priceContent(settled: Settled | null) {
  if (!settled) return "Checking prices…";
  if (settled.kind === "timeout") return "Price check timed out";
  if (settled.kind === "error") return "Price unavailable";
  const { row } = settled;
  if (row.status === "pending") return "Price check in progress";
  if (row.reason === "deadline" || row.reason === "validation_unavailable")
    return "Price check timed out";
  if (row.status !== "quote" || !row.display_amount) return "Price unavailable";
  return <strong>{row.display_amount}</strong>;
}

/** What a price slot settles to: the Edition's price row, a client timeout, or an error. */
export type PriceSettled = Settled;

/**
 * The cached price row of one Card Edition for a page that renders it itself (the deck builder's List view
 * multiplies it by a line's quantity). It is requested once `slot` first comes near the viewport, through
 * the same batched queue as EditionPrice; null while the check is pending.
 */
export function useEditionPriceRow(
  editionId: string,
  slot: RefObject<Element | null>
): PriceSettled | null {
  const cached = cache.get(editionId);
  const [state, setState] = useState<{ id: string; value: Settled | null }>(
    () => ({
      id: editionId,
      value: cached ? { kind: "row", row: cached } : null,
    })
  );
  useEffect(() => {
    let cancel = () => {};
    const stop = whenNear(slot.current, () => {
      cancel = request(editionId, (value) =>
        setState({ id: editionId, value })
      );
    });
    return () => {
      stop();
      cancel();
    };
  }, [editionId]);
  return cached
    ? { kind: "row", row: cached }
    : state.id === editionId
      ? state.value
      : null;
}

/** The cached price of one Card Edition, requested through the shared batched queue. */
export function EditionPrice({ editionId }: { editionId: string }) {
  const slot = useRef<HTMLSpanElement>(null);
  const settled = useEditionPriceRow(editionId, slot);
  return (
    <span
      ref={slot}
      className="edition-price"
      data-price-status={
        !settled
          ? "checking"
          : settled.kind === "row"
            ? settled.row.status
            : settled.kind
      }
    >
      {priceContent(settled)}
    </span>
  );
}
