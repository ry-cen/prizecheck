import { useEffect, useId, useRef, useState } from "react";
import { searchCatalog, type PrintingView } from "../generated";
import { lineEdition } from "../loans/loanText";
import {
  ACCOUNT_SUSPENDED_NOTE,
  DISCOVERY_REMOVED,
} from "../settings/discoveryMessages";
import { CardImage } from "../social/FriendCollectionPage";
import {
  getTradeCardSearch,
  type CardHolder,
  type TradeCardSearch,
} from "../social_generated";
import { Button } from "../ui/Button";
import { Pill } from "../ui/Pill";
import { SearchField } from "../ui/SearchField";
import { Segmented } from "../ui/Segmented";
import { RETRY } from "./conversationMessages";
import { MessageLink } from "./MessageLink";
import {
  CARD_OPTIONS_LABEL,
  CARD_SEARCH_HEADING,
  CARD_SEARCH_HELP,
  CARD_SEARCH_LABEL,
  CARD_SEARCH_LOADING,
  CARDS_FAILED,
  CHANGE_CARD,
  FRIEND_HOLDERS_LABEL,
  FRIENDS_HEADING,
  FRIENDS_NONE,
  HOLDERS_FAILED,
  HOLDERS_LOADING,
  NEAR_HEADING,
  NEAR_HOLDERS_LABEL,
  NEAR_NONE,
  NEAR_SEARCH_OFF,
  SCOPE_LABEL,
  SCOPE_OPTIONS,
  moreCards,
} from "./nearYouMessages";
import { proposalPath } from "./tradeListModel";
import { traderMeta } from "./traderMessages";

const SEARCH_DELAY_MS = 250;
const NO_CARD_MATCH = "No cards match that name.";

type Scope = "name" | "set" | "printing";

type Options =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "failed" }
  | { kind: "ready"; printings: PrintingView[] };

type Holders =
  | { kind: "loading" }
  | { kind: "failed" }
  | { kind: "ready"; search: TradeCardSearch };

/**
 * Card search (Trading #300), the first block of Find trades: type a card name, pick a Printing, and see which Friends
 * and which collectors near you have a card for trade. The search covers every printing of the card by name, this
 * card's set, or this printing alone. Friends come first, then nearby collectors within the radius chosen under Near
 * you (`revision` changes when that choice or the discovery setting does, and the results are read again). Each holder
 * leads to Message and Propose trade. A holder shows a name, the band and track record, never a Handle, zip code or
 * distance. There is no search for who wants a card.
 */
export function CardSearch({
  onNavigate,
  revision,
}: {
  onNavigate: (to: string) => void;
  revision: number;
}) {
  const headingId = useId();
  const searchBox = useRef<HTMLDivElement>(null);
  const pickedBox = useRef<HTMLDivElement>(null);
  const [typed, setTyped] = useState("");
  const [q, setQ] = useState("");
  const [options, setOptions] = useState<Options>({ kind: "idle" });
  const [optionsAttempt, setOptionsAttempt] = useState(0);
  const [picked, setPicked] = useState<PrintingView | null>(null);
  const [scope, setScope] = useState<Scope>("name");
  const [holders, setHolders] = useState<Holders>({ kind: "loading" });
  const [holdersAttempt, setHoldersAttempt] = useState(0);
  const [reading, setReading] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setQ(typed.trim()), SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [typed]);

  useEffect(() => {
    if (q.replace(/\s/g, "").length < 2) {
      setOptions({ kind: "idle" });
      return;
    }
    const controller = new AbortController();
    setOptions({ kind: "loading" });
    searchCatalog({ name: q })
      .then((response) => {
        if (controller.signal.aborted) return;
        setOptions({
          kind: "ready",
          printings: response.available ? response.printings : [],
        });
      })
      .catch(() => {
        if (!controller.signal.aborted) setOptions({ kind: "failed" });
      });
    return () => controller.abort();
  }, [q, optionsAttempt]);

  useEffect(() => {
    if (!picked) return;
    const controller = new AbortController();
    setReading(true);
    setHolders((current) =>
      current.kind === "ready" ? current : { kind: "loading" }
    );
    getTradeCardSearch(picked.id, scope, controller.signal)
      .then((search) => {
        if (controller.signal.aborted) return;
        setHolders({ kind: "ready", search });
        setReading(false);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setHolders({ kind: "failed" });
        setReading(false);
      });
    return () => controller.abort();
  }, [picked, scope, revision, holdersAttempt]);

  function pick(printing: PrintingView) {
    setHolders({ kind: "loading" });
    setScope("name");
    setPicked(printing);
    window.setTimeout(
      () => pickedBox.current?.querySelector("button")?.focus(),
      0
    );
  }

  function change() {
    setPicked(null);
    window.setTimeout(
      () => searchBox.current?.querySelector("input")?.focus(),
      0
    );
  }

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="m-0 text-heading font-semibold">
        {CARD_SEARCH_HEADING}
      </h2>
      <p className="m-0 text-body text-text-muted">{CARD_SEARCH_HELP}</p>
      {picked ? (
        <>
          <div ref={pickedBox} className="flex flex-wrap items-center gap-3">
            <div className="grid w-full max-w-sm grid-cols-[2.5rem_minmax(0,1fr)] items-center gap-3">
              <CardImage url={picked.low_image_url} />
              <span className="flex min-w-0 flex-col gap-1">
                <span className="text-body font-semibold wrap-anywhere">
                  {picked.name}
                </span>
                <span className="text-meta text-text-muted wrap-anywhere">
                  {picked.set_name} {picked.collector_number}
                </span>
              </span>
            </div>
            <Button onClick={change}>{CHANGE_CARD}</Button>
          </div>
          <Segmented
            mode="choice"
            label={SCOPE_LABEL}
            options={SCOPE_OPTIONS}
            value={scope}
            onChange={setScope}
          />
          <div
            aria-busy={reading}
            className={`flex flex-col gap-3 ${reading ? "opacity-60" : ""}`}
          >
            <Results
              holders={holders}
              onRetry={() => setHoldersAttempt((n) => n + 1)}
              onNavigate={onNavigate}
            />
          </div>
        </>
      ) : (
        <>
          <div ref={searchBox}>
            <SearchField
              label={CARD_SEARCH_LABEL}
              placeholder={CARD_SEARCH_LABEL}
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
            />
          </div>
          {options.kind === "loading" && (
            <p role="status" className="m-0 text-body text-text-muted">
              {CARD_SEARCH_LOADING}
            </p>
          )}
          {options.kind === "failed" && (
            <div className="flex flex-wrap items-center gap-3">
              <p role="alert" className="m-0 text-body text-danger">
                {CARDS_FAILED}
              </p>
              <Button onClick={() => setOptionsAttempt((n) => n + 1)}>
                {RETRY}
              </Button>
            </div>
          )}
          {options.kind === "ready" && options.printings.length === 0 && (
            <p role="status" className="m-0 text-body text-text-muted">
              {NO_CARD_MATCH}
            </p>
          )}
          {options.kind === "ready" && options.printings.length > 0 && (
            <ul
              aria-label={CARD_OPTIONS_LABEL}
              className="m-0 flex list-none flex-col gap-2 p-0"
            >
              {options.printings.map((printing) => (
                <li key={printing.id}>
                  <button
                    type="button"
                    aria-label={`${printing.name}, ${printing.set_name} ${printing.collector_number}`}
                    onClick={() => pick(printing)}
                    className="box-border grid min-h-tap w-full cursor-pointer grid-cols-[2.5rem_minmax(0,1fr)] items-center gap-3 rounded-panel border border-border bg-surface px-3 py-2 text-left font-sans text-text hover:bg-surface-raised"
                  >
                    <CardImage url={printing.low_image_url} />
                    <span className="flex min-w-0 flex-col gap-1">
                      <span className="text-body font-semibold wrap-anywhere">
                        {printing.name}
                      </span>
                      <span className="text-meta text-text-muted wrap-anywhere">
                        {printing.set_name} {printing.collector_number}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function Results({
  holders,
  onRetry,
  onNavigate,
}: {
  holders: Holders;
  onRetry: () => void;
  onNavigate: (to: string) => void;
}) {
  if (holders.kind === "loading")
    return (
      <p role="status" className="m-0 text-body text-text-muted">
        {HOLDERS_LOADING}
      </p>
    );
  if (holders.kind === "failed")
    return (
      <div className="flex flex-wrap items-center gap-3">
        <p role="alert" className="m-0 text-body text-danger">
          {HOLDERS_FAILED}
        </p>
        <Button onClick={onRetry}>{RETRY}</Button>
      </div>
    );
  const { search } = holders;
  if (search.status === "suspended")
    return (
      <p className="m-0 text-body text-text-muted">{ACCOUNT_SUSPENDED_NOTE}</p>
    );
  return (
    <>
      <HolderList
        heading={FRIENDS_HEADING}
        label={FRIEND_HOLDERS_LABEL}
        holders={search.friends}
        none={FRIENDS_NONE}
        onNavigate={onNavigate}
      />
      <HolderList
        heading={NEAR_HEADING}
        label={NEAR_HOLDERS_LABEL}
        holders={search.near}
        none={
          search.status === "off"
            ? NEAR_SEARCH_OFF
            : search.status === "removed"
              ? DISCOVERY_REMOVED
              : NEAR_NONE
        }
        onNavigate={onNavigate}
      />
    </>
  );
}

function HolderList({
  heading,
  label,
  holders,
  none,
  onNavigate,
}: {
  heading: string;
  label: string;
  holders: CardHolder[];
  none: string;
  onNavigate: (to: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="m-0 text-body font-semibold">{heading}</h3>
      {holders.length === 0 ? (
        <p role="status" className="m-0 text-body text-text-muted">
          {none}
        </p>
      ) : (
        <ul
          aria-label={label}
          className="m-0 flex list-none flex-col gap-3 p-0"
        >
          {holders.map((holder) => (
            <Holder
              key={holder.trader_id}
              holder={holder}
              onNavigate={onNavigate}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function Holder({
  holder,
  onNavigate,
}: {
  holder: CardHolder;
  onNavigate: (to: string) => void;
}) {
  const name = holder.display_name;
  const meta = traderMeta(holder.band, holder.completed_trades);
  return (
    <li className="flex flex-col gap-3 rounded-panel border border-border bg-surface px-4 py-3">
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-body font-semibold wrap-anywhere">{name}</span>
        {holder.open_to_cash_offers && <Pill>Open to cash offers</Pill>}
        {meta !== null && (
          <span className="text-meta text-text-muted">{meta}</span>
        )}
      </span>
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {holder.cards.map((card) => (
          <li
            key={card.edition_id}
            className="flex items-baseline justify-between gap-3"
          >
            <span className="flex min-w-0 flex-col">
              <span className="text-body wrap-anywhere">{card.name}</span>
              <span className="text-meta text-text-muted tabular-nums wrap-anywhere">
                {lineEdition(card)}
              </span>
            </span>
            <span className="text-body font-semibold tabular-nums">
              ×{card.copies}
            </span>
          </li>
        ))}
      </ul>
      {holder.more_cards > 0 && (
        <span className="text-meta text-text-muted">
          {moreCards(holder.more_cards)}
        </span>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="primary"
          aria-label={`Propose trade to ${name}`}
          onClick={() => onNavigate(proposalPath(holder.trader_id))}
        >
          Propose trade
        </Button>
        <MessageLink
          traderId={holder.trader_id}
          name={name}
          onNavigate={onNavigate}
        />
      </div>
    </li>
  );
}
