import { useEffect, useId, useRef, useState } from "react";
import {
  browseEditions,
  type BrowseEdition,
} from "../catalog_browse_generated";
import { CopyArt } from "../ui/CopyTile";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { SearchField } from "../ui/SearchField";
import { SelectBox } from "../ui/Select";
import { Stepper } from "../ui/Stepper";
import { useDebouncedValue } from "../workspace/useDebouncedValue";
import type { WantListLine } from "../want_list_generated";
import {
  cardText,
  MAX_TRADE_WANT_COPIES,
  WILL_ACCEPT_OPTIONS,
} from "./tradeWantsModel";
import type { TradeWantsApi } from "./useTradeWants";
import { editionText } from "./wantListModel";

/**
 * The Will accept select on a Want List line (Trading #275; prototype variant A): what trades should accept for this
 * card, wherever it appears on the Want List. Shown once the collector's choices are read; every line of the same
 * Card Edition shows the same choice.
 */
export function WillAcceptSelect({
  line,
  api,
}: {
  line: WantListLine;
  api: TradeWantsApi;
}) {
  if (api.state.kind !== "ready") return null;
  const rule =
    api.pendingRule?.edition_id === line.edition_id
      ? api.pendingRule.rule
      : (api.state.rules.get(line.edition_id) ?? "edition");
  return (
    <div className="mt-1 max-w-64">
      <SelectBox
        aria-label={`Will accept for ${cardText(line)}`}
        value={rule}
        aria-disabled={api.busy || undefined}
        onChange={(event) => {
          if (!api.busy)
            api.setRule(
              line,
              event.target
                .value as (typeof WILL_ACCEPT_OPTIONS)[number]["value"]
            );
        }}
      >
        {WILL_ACCEPT_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </SelectBox>
    </div>
  );
}

/** Visible choices for page tiles; names stay unique across Deck sections. */
export function WillAcceptRadios({
  line,
  api,
}: {
  line: WantListLine;
  api: TradeWantsApi;
}) {
  const name = useId();
  if (api.state.kind !== "ready") return null;
  const rule =
    api.pendingRule?.edition_id === line.edition_id
      ? api.pendingRule.rule
      : (api.state.rules.get(line.edition_id) ?? "edition");
  return (
    <div
      role="radiogroup"
      aria-label={`Will accept for ${cardText(line)}`}
      aria-disabled={api.busy || undefined}
      className="mt-2 flex min-w-0 flex-col gap-1"
    >
      {WILL_ACCEPT_OPTIONS.map((option) => (
        <label
          key={option.value}
          className={`flex min-h-8 min-w-0 cursor-pointer items-center gap-2 rounded-control border px-2 py-1 text-meta phone:min-h-tap ${rule === option.value ? "border-accent-border bg-surface-selected font-semibold text-accent-strong" : "border-border-strong text-text-muted"}`}
        >
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={rule === option.value}
            aria-disabled={api.busy || undefined}
            onChange={() => {
              if (!api.busy && rule !== option.value)
                api.setRule(line, option.value);
            }}
            className="m-0 shrink-0 accent-accent"
          />
          <span className="min-w-0 wrap-anywhere">{option.label}</span>
        </label>
      ))}
    </div>
  );
}

export const TRADE_WANTS_HEADING = "trade-wants";

export function focusTradeWants() {
  const heading = document.getElementById(TRADE_WANTS_HEADING);
  heading?.focus({ preventScroll: true });
  heading?.scrollIntoView({ block: "start" });
}

export function tradeWantCounts(lines: readonly { quantity: string }[]) {
  return {
    copies: lines.reduce((sum, line) => sum + Number(line.quantity), 0),
    entries: lines.length,
  };
}

export function TradeWantsShortcut({ api }: { api: TradeWantsApi }) {
  if (api.state.kind !== "ready" || api.state.wants.lines.length === 0)
    return null;
  const lines = api.state.wants.lines;
  const { copies, entries } = tradeWantCounts(lines);
  return (
    <p className="m-0 basis-full text-meta text-text-muted">
      <a
        href="#trade-wants"
        className="inline-flex min-h-tap max-w-full items-center rounded-control text-accent-strong underline wrap-anywhere"
        onClick={(event) => {
          event.preventDefault();
          focusTradeWants();
        }}
      >
        Trade Wants · {copies} {copies === 1 ? "copy" : "copies"} across{" "}
        {entries} {entries === 1 ? "entry" : "entries"}
      </a>
      <span className="block">Separate from Deck To get quantities.</span>
    </p>
  );
}

/**
 * Trade Wants, the panel after the Decks on the Want List (Trading #275; prototype variant A): the exact cards the
 * collector wants in trades that no Deck names, each with a stepper (0 removes it), and **Add a card**, which searches
 * the catalog by name. Nothing here changes a Want List figure. Its heading is an h2, as in the prototype: the panel
 * is a part of the page beside the Want List, not one of its Deck sections (h3).
 */
export function TradeWantsPanel({ api }: { api: TradeWantsApi }) {
  const [adding, setAdding] = useState(false);
  const { state } = api;
  const { copies, entries } = tradeWantCounts(
    state.kind === "ready" ? state.wants.lines : []
  );
  return (
    <section
      aria-labelledby={TRADE_WANTS_HEADING}
      className="rounded-panel border border-border bg-surface"
    >
      <div className="flex flex-col gap-1 px-4 py-2">
        <h2
          id={TRADE_WANTS_HEADING}
          tabIndex={-1}
          className="m-0 scroll-mt-[calc(var(--layout-sticky-top)+var(--space-4))] text-body font-semibold wrap-anywhere"
        >
          Trade Wants
        </h2>
        <p className="m-0 text-meta text-text-muted">
          Trade Wants match the exact card and are not included in Deck To get
          or Combined total.
        </p>
      </div>
      {state.kind === "ready" && state.wants.lines.length > 0 && (
        <p className="m-0 px-4 pb-2 text-meta text-text-muted">
          {copies} {copies === 1 ? "copy" : "copies"} across {entries}{" "}
          {entries === 1 ? "entry" : "entries"}
        </p>
      )}
      {state.kind === "loading" ? (
        <p
          role="status"
          className="m-0 border-t border-border px-4 py-3 text-body text-text-muted"
        >
          Loading your Trade Wants…
        </p>
      ) : state.kind === "failed" ? (
        <div className="flex flex-wrap items-center gap-3 border-t border-border px-4 py-3">
          <p role="status" className="m-0 text-body text-text-muted">
            Your Trade Wants couldn't be loaded.
          </p>
          <Button onClick={api.retry}>Retry</Button>
        </div>
      ) : (
        <>
          {state.wants.lines.length === 0 ? (
            <p className="m-0 border-t border-border px-4 py-3 text-body text-text-muted">
              No Trade Wants yet.
            </p>
          ) : (
            <ul
              aria-label="Your Trade Wants"
              className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4 border-t border-border p-4 phone:grid-cols-1 phone:gap-3 phone:p-3"
            >
              {state.wants.lines.map((line) => (
                <li
                  key={line.edition_id}
                  className="min-w-0 rounded-card border border-border p-2 phone:grid phone:grid-cols-[64px_minmax(0,1fr)] phone:items-start phone:gap-3"
                >
                  <CopyArt
                    name={line.name}
                    imageUrl={line.image_url}
                    className="mx-auto w-(--tile-medium) max-w-full phone:w-full"
                  />
                  <div className="min-w-0">
                    <p className="m-0 mt-2 text-body font-medium wrap-anywhere phone:mt-0">
                      {line.name}
                    </p>
                    <p className="m-0 text-meta text-text-muted wrap-anywhere">
                      {editionText(line)}
                    </p>
                    <div className="mt-2">
                      <Stepper
                        label={cardText(line)}
                        value={Number(line.quantity)}
                        max={MAX_TRADE_WANT_COPIES}
                        disabled={api.busy}
                        onChange={(value) => void api.setQuantity(line, value)}
                      />
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap items-center gap-3 border-t border-border px-4 py-3">
            <Button onClick={() => setAdding(true)} className="phone:w-full">
              Add a card
            </Button>
            <p
              role="status"
              className="m-0 text-meta text-warning empty:sr-only"
            >
              {adding ? "" : api.refusal}
            </p>
          </div>
          <AddTradeWant
            open={adding}
            onClose={() => {
              setAdding(false);
              api.clearRefusal();
            }}
            api={api}
          />
        </>
      )}
    </section>
  );
}

type Found =
  | { status: "idle" }
  | { status: "searching"; editions: BrowseEdition[] }
  | {
      status: "done";
      editions: BrowseEdition[];
      next: string | null;
      more: boolean;
    }
  | { status: "failed" };

/**
 * Add a card: a catalog search by card name, with every matching Card Edition grouped under its card's name, each
 * with Add, which adds one copy (or one more) to Trade Wants. The dialog stays open, so several cards can be added.
 */
function AddTradeWant({
  open,
  onClose,
  api,
}: {
  open: boolean;
  onClose: () => void;
  api: TradeWantsApi;
}) {
  const [query, setQuery] = useState("");
  const q = useDebouncedValue(query.trim(), 250);
  const [found, setFound] = useState<Found>({ status: "idle" });
  // Counts the searches (and closes): a Show more page started under an earlier search, or before the picker closed,
  // is dropped on arrival.
  const generation = useRef(0);

  useEffect(() => {
    generation.current++;
    if (!open || !q) {
      setFound({ status: "idle" });
      return;
    }
    const controller = new AbortController();
    setFound((previous) => ({
      status: "searching",
      editions: previous.status === "done" ? previous.editions : [],
    }));
    browseEditions({ q }, null, controller.signal)
      .then((page) => {
        if (controller.signal.aborted) return;
        setFound({
          status: "done",
          editions: page.editions,
          next: page.next_cursor,
          more: false,
        });
      })
      .catch(() => {
        if (!controller.signal.aborted) setFound({ status: "failed" });
      });
    return () => controller.abort();
  }, [open, q]);

  async function showMore() {
    if (found.status !== "done" || !found.next || found.more) return;
    const current = found;
    const at = generation.current;
    setFound({ ...current, more: true });
    try {
      const page = await browseEditions({ q }, current.next);
      if (generation.current !== at) return;
      setFound({
        status: "done",
        editions: [...current.editions, ...page.editions],
        next: page.next_cursor,
        more: false,
      });
    } catch {
      if (generation.current !== at) return;
      // A moved catalog (409) or a failure: search again from the start.
      setFound({ status: "failed" });
    }
  }

  const quantities =
    api.state.kind === "ready"
      ? new Map(
          api.state.wants.lines.map((line) => [
            line.edition_id,
            Number(line.quantity),
          ])
        )
      : new Map<string, number>();
  const editions =
    found.status === "done" || found.status === "searching"
      ? found.editions
      : [];
  const groups = new Map<string, BrowseEdition[]>();
  for (const edition of editions)
    groups.set(edition.name, [...(groups.get(edition.name) ?? []), edition]);

  return (
    <Dialog
      open={open}
      onClose={() => {
        setQuery("");
        onClose();
      }}
      title="Add a card"
      closeLabel="Close Add a card"
      size="wide"
    >
      <div className="flex flex-col gap-3 p-4">
        <SearchField
          label="Search by card name"
          placeholder="Search by card name"
          value={query}
          data-autofocus
          onChange={(event) => setQuery(event.target.value)}
        />
        <p
          role="status"
          className="m-0 text-meta text-text-muted empty:sr-only"
        >
          {api.refusal ||
            (found.status === "searching"
              ? "Searching…"
              : found.status === "failed"
                ? "Search isn't available right now."
                : found.status === "done" && editions.length === 0
                  ? "No cards match that name."
                  : "")}
        </p>
        {[...groups].map(([name, cards]) => (
          <div key={name} className="flex flex-col gap-1">
            <h3 className="m-0 text-body font-semibold wrap-anywhere">
              {name}
            </h3>
            <ul
              aria-label={name}
              className="m-0 flex list-none flex-col gap-1 p-0"
            >
              {cards.map((edition) => {
                const have = quantities.get(edition.edition_id) ?? 0;
                return (
                  <li
                    key={edition.edition_id}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1"
                  >
                    <span className="min-w-0 flex-1 text-body wrap-anywhere">
                      {editionText(edition)}
                      {have > 0 && (
                        <span className="text-meta text-text-muted">
                          {" "}
                          · {have} in Trade Wants
                        </span>
                      )}
                    </span>
                    <Button
                      aria-label={`Add ${cardText(edition)}`}
                      aria-disabled={
                        api.busy || have >= MAX_TRADE_WANT_COPIES || undefined
                      }
                      onClick={() => {
                        if (!api.busy && have < MAX_TRADE_WANT_COPIES)
                          void api.setQuantity(edition, have + 1, "added");
                      }}
                    >
                      Add
                    </Button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
        {found.status === "done" && found.next && (
          <Button
            className="self-start"
            aria-disabled={found.more || undefined}
            onClick={() => void showMore()}
          >
            Show more
          </Button>
        )}
        <Button
          onClick={() => {
            setQuery("");
            onClose();
          }}
          className="self-end phone:self-stretch"
        >
          Done
        </Button>
      </div>
    </Dialog>
  );
}
