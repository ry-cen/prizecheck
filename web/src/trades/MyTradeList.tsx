import { useEffect, useId, useState } from "react";
import { CardImage } from "../social/FriendCollectionPage";
import { getTradeList, type OwnTradeList } from "../trades_generated";
import { Button } from "../ui/Button";
import { variantLabel } from "../ui/variantLabel";
import { HIDDEN_ON_TRADE_LIST } from "../workspace/locationTree";
import { OpenToCashOffers } from "./OpenToCashOffers";
import { tradeListPanels, type TradeListPanel } from "./tradeListModel";

type Load =
  | { kind: "loading" }
  | { kind: "failed" }
  | { kind: "ready"; list: OwnTradeList };

/**
 * My Trade List (Trading #269, prototype verdict variant A): every card in the collector's For trade Locations that
 * they offer now, in one panel per Location in tree order, so they know where to look when a Trade is agreed. A
 * Location hidden from Friends says its cards are still on the Trade List. Copies promised to a Trade or Loan are not
 * shown. Friends see the same cards and counts, never a Location.
 *
 * The Open to cash offers setting (Trading #277) sits at the top, above the list, whatever state the list is in.
 */
export function MyTradeList({
  onOpenCollection,
}: {
  onOpenCollection: () => void;
}) {
  // The setting is mounted once, first, so it never reloads as the list goes from loading to ready or is retried.
  return (
    <>
      <OpenToCashOffers />
      <p className="m-0 text-body text-text-muted">
        This list shows cards you offer for trade. For cards you want, open{" "}
        <a
          href="/decks/want-list"
          className="inline-flex min-h-tap items-center rounded-control text-accent-strong underline"
        >
          Trade Wants on the Want List
        </a>
        .
      </p>
      <TradeListBody onOpenCollection={onOpenCollection} />
    </>
  );
}

function TradeListBody({ onOpenCollection }: { onOpenCollection: () => void }) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    getTradeList(controller.signal).then(
      (list) => {
        if (!controller.signal.aborted) setLoad({ kind: "ready", list });
      },
      () => {
        if (!controller.signal.aborted) setLoad({ kind: "failed" });
      }
    );
    return () => controller.abort();
  }, [attempt]);

  if (load.kind === "loading")
    return (
      <p role="status" className="m-0 text-body text-text-muted">
        Loading your Trade List…
      </p>
    );
  if (load.kind === "failed")
    return (
      <div className="flex flex-wrap items-center gap-3">
        <p role="status" className="m-0 text-body text-text-muted">
          Your Trade List couldn't be loaded.
        </p>
        <Button
          onClick={() => {
            setLoad({ kind: "loading" });
            setAttempt((n) => n + 1);
          }}
        >
          Retry
        </Button>
      </div>
    );

  const panels = tradeListPanels(load.list);
  return (
    <>
      <p className="m-0 text-body text-text-muted">
        Friends see the cards and counts, never where they are.
      </p>
      {panels.length === 0 ? (
        <div className="flex flex-col items-start gap-3">
          <p className="m-0 text-body text-text-muted">
            Your Trade List is empty. Mark a Location For trade in Collection,
            and its cards show here.
          </p>
          <Button onClick={onOpenCollection}>Open Collection</Button>
        </div>
      ) : (
        <>
          {panels.map((panel) => (
            <LocationPanel key={panel.location.id} panel={panel} />
          ))}
          <p className="m-0 text-meta text-text-subtle">
            Cards promised to a Trade or Loan leave this list until they're
            released.
          </p>
        </>
      )}
    </>
  );
}

/** One For trade Location: its path, the hidden mark when Friends can't see it, and its cards with their copies. */
function LocationPanel({ panel }: { panel: TradeListPanel }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <div className="flex min-w-0 flex-col gap-1">
        <h2
          id={headingId}
          className="m-0 text-heading font-semibold wrap-anywhere"
        >
          {panel.title}
        </h2>
        {panel.location.hidden && (
          <p className="m-0 text-meta text-text-muted">
            {HIDDEN_ON_TRADE_LIST}
          </p>
        )}
      </div>
      <ul
        aria-label={panel.title}
        className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-4 rounded-panel border border-border bg-surface p-4"
      >
        {panel.cards.map(({ card, copies }) => (
          <li
            key={card.edition_id}
            className="flex min-w-0 flex-col items-start gap-2"
          >
            <div className="w-full max-w-[145px] self-center">
              <CardImage url={card.image_url} />
            </div>
            <span className="flex min-w-0 flex-col">
              <span className="text-body font-semibold wrap-anywhere">
                {card.name}
              </span>
              <span className="text-meta text-text-muted tabular-nums wrap-anywhere">
                {card.set_code} {card.collector_number} ·{" "}
                {variantLabel(card.descriptor)}
              </span>
            </span>
            <span className="text-body font-semibold tabular-nums">
              ×{copies}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
