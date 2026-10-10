import { useEffect, useState } from "react";
import {
  getEditionPrices,
  MAX_PRICE_EDITIONS,
  PriceError,
  type PriceRow,
} from "./prices_generated";
import "./EditionPrice.css";

// A price is a cached, server-validated enrichment. The rest of the page never waits for it: each slot asks
// for its own Edition, the requests of one render are batched (at most 64 ids each), and an answer that
// takes longer than the gateway budget becomes a labelled fallback instead of a spinner.
const CLIENT_TIMEOUT_MS = 3_500;
const BATCH_DELAY_MS = 15;

type Settled =
  { kind: "row"; row: PriceRow } | { kind: "timeout" } | { kind: "error" };
type Waiter = (settled: Settled) => void;

const MAX_IN_FLIGHT = 2;

const waiting = new Map<string, Set<Waiter>>();
const queue: Array<Map<string, Set<Waiter>>> = [];
let inFlight = 0;
let scheduled: ReturnType<typeof setTimeout> | null = null;

// Batches wait here (never more than MAX_IN_FLIGHT on the wire); there is no polling and no retry.
function pump() {
  while (inFlight < MAX_IN_FLIGHT && queue.length) send(queue.shift()!);
}

function send(waiters: Map<string, Set<Waiter>>) {
  const ids = [...waiters.keys()];
  const settle = (settled: (id: string) => Settled) => {
    for (const [id, set] of waiters)
      for (const waiter of set) waiter(settled(id));
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
  for (const [id, set] of waiting) if (!set.size) waiting.delete(id); // unmounted before the batch left
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
  const set = waiting.get(editionId) ?? new Set<Waiter>();
  set.add(waiter);
  waiting.set(editionId, set);
  if (!scheduled) scheduled = setTimeout(flush, BATCH_DELAY_MS);
  return () => {
    set.delete(waiter);
  };
}

const UNAVAILABLE: Record<string, string> = {
  unspecified_variant: "Price unavailable: finish not established",
  not_found: "Price unavailable",
  unverified: "Price unavailable: not matched to a reviewed market listing",
  quarantined: "Price unavailable: market matching is under review",
  no_quote_variant:
    "Price unavailable: no market price variant for this Edition",
  not_cached: "No cached price yet",
  confirmed_absent: "No market price is listed for this Edition",
  lookup_mismatch: "Price unavailable: the cached price failed validation",
  invalid_quote: "Price unavailable: the cached price failed validation",
  store_unavailable: "Price temporarily unavailable",
  deadline: "Price check timed out",
  validation_unavailable: "Price check timed out",
};

function moment(iso: string) {
  return `${iso.slice(0, 16).replace("T", " ")} UTC`;
}

function Quote({ row }: { row: PriceRow }) {
  return (
    <>
      <strong>{row.display_amount}</strong> cached TCGplayer market price (USD)
      {row.age === "known" && row.provider_updated_at ? (
        <> · Price time {moment(row.provider_updated_at)}</>
      ) : (
        <> · Age unknown</>
      )}
      {row.stale && <> · Stale: the price is over 48 hours old</>}
      {row.checked_at && <> · Last checked {moment(row.checked_at)}</>}
    </>
  );
}

function Refresh({ row }: { row: PriceRow }) {
  const cached = row.status === "quote" ? " — showing cached" : "";
  let text: string | null = null;
  if (row.refresh === "background") text = "Refreshing in background";
  else if (row.refresh === "refreshed") text = "Refreshed just now";
  else if (row.refresh === "timeout") text = `Refresh timed out${cached}`;
  else if (row.refresh === "busy") text = `Refresh busy${cached}`;
  else if (row.refresh === "backoff") text = `Source backing off${cached}`;
  else if (row.refresh === "failed" || row.refresh_failed_at)
    text = `Last refresh failed${
      row.refresh_failed_at ? ` at ${moment(row.refresh_failed_at)}` : ""
    }${cached}`;
  if (!text) return null;
  return (
    <span className="price-refresh" data-refresh={row.refresh ?? "failed"}>
      {" "}
      · {text}
    </span>
  );
}

export function EditionPrice({ editionId }: { editionId: string }) {
  const [settled, setSettled] = useState<Settled | null>(null);
  useEffect(() => {
    setSettled(null);
    return request(editionId, setSettled);
  }, [editionId]);
  let content;
  let status = "checking";
  if (!settled) content = "Checking prices…";
  else if (settled.kind === "timeout") {
    status = "timeout";
    content = "Price check timed out. The rest of this page is unaffected.";
  } else if (settled.kind === "error") {
    status = "error";
    content = "Prices are temporarily unavailable.";
  } else {
    const { row } = settled;
    status = row.status;
    if (row.status === "quote") content = <Quote row={row} />;
    else if (row.status === "pending") content = "Price check in progress";
    else content = UNAVAILABLE[row.reason ?? ""] ?? "Price unavailable";
  }
  return (
    <span className="edition-price" data-price-status={status}>
      {content}
      {settled?.kind === "row" && <Refresh row={settled.row} />}
    </span>
  );
}
