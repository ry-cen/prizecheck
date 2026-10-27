import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { PageHeader } from "../shell/PageHeader";
import { friendCollectionPath } from "../social/friendCards";
import {
  getFriendTradeList,
  SocialError,
  type FriendTradeCard,
  type FriendTradeList,
} from "../social_generated";
import { Button } from "../ui/Button";
import { SearchField } from "../ui/SearchField";
import { variantLabel } from "../ui/variantLabel";
import { trackRecord } from "./conversationMessages";
import { proposeFromTradeList } from "./openProposal";
import {
  friendTradeListPath,
  groupByName,
  proposalPath,
} from "./tradeListModel";

type Load =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "failed" }
  | {
      kind: "ready";
      page: FriendTradeList;
      cards: FriendTradeCard[];
      more: "idle" | "loading" | "failed";
      /** The search the answer was read for. */
      q: string;
    };

const LINK =
  "inline-flex h-control items-center gap-1 rounded-control px-2 text-control font-medium text-accent-strong no-underline hover:bg-surface-raised phone:h-control-phone";

// How long the search waits after the last keystroke before it reads again, as on a Friend's Collection.
const SEARCH_DELAY_MS = 300;

/**
 * A Friend's Trade List (Trading #269, prototype verdict variant A), at /friends/<Handle>/trade-list: every card one
 * Friend offers to trade now, grouped by card name, each Edition with how many copies. It never names a Location or a
 * Deck of theirs, hidden or not. Search narrows by card name; **Show more cards** reads the next page. A Handle that
 * isn't one of the collector's Friends gets the same plain sentence as a Friend's Collection, whatever the reason.
 *
 * **Propose trade** opens the proposal builder to this Friend (Trading #284), where their Trade List can be searched
 * and cards added; its back link returns here.
 */
export function FriendTradeListPage({
  handle,
  onNavigate,
}: {
  handle: string;
  onNavigate: (to: string) => void;
}) {
  const [typed, setTyped] = useState("");
  const [q, setQ] = useState("");
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  // Whether the first unfiltered answer for this Friend listed nothing at all, so a search can't hide that.
  const [nothingListed, setNothingListed] = useState(false);
  const listId = useId();
  // Bumped each time the main read starts, so a Show more read begun under an earlier search is dropped on arrival.
  const generation = useRef(0);

  useEffect(() => {
    const timer = window.setTimeout(() => setQ(typed.trim()), SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [typed]);

  useEffect(() => setNothingListed(false), [handle]);

  useEffect(() => {
    const controller = new AbortController();
    generation.current++;
    setLoad((current) =>
      current.kind === "ready" ? current : { kind: "loading" }
    );
    getFriendTradeList(handle, { q }, controller.signal)
      .then((page) => {
        if (controller.signal.aborted) return;
        if (q === "") setNothingListed(page.cards.length === 0);
        setLoad({ kind: "ready", page, cards: page.cards, more: "idle", q });
      })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        setLoad(
          cause instanceof SocialError && cause.status === 404
            ? { kind: "missing" }
            : { kind: "failed" }
        );
      });
    return () => controller.abort();
  }, [handle, q, attempt]);

  async function showMore() {
    if (
      load.kind !== "ready" ||
      load.page.next_page === null ||
      load.more === "loading" ||
      load.q !== q
    )
      return;
    const current = load;
    const at = generation.current;
    setLoad({ ...current, more: "loading" });
    try {
      const page = await getFriendTradeList(handle, {
        q: current.q,
        page: current.page.next_page!,
      });
      if (generation.current !== at) return;
      setLoad({
        kind: "ready",
        page,
        cards: [...current.cards, ...page.cards],
        more: "idle",
        q: current.q,
      });
    } catch (cause) {
      if (generation.current !== at) return;
      if (cause instanceof SocialError && cause.status === 404) {
        setLoad({ kind: "missing" });
        return;
      }
      setLoad({ ...current, more: "failed" });
    }
  }

  const frame = (title: string, children: ReactNode, actions?: ReactNode) => (
    <main className="mx-auto box-border flex max-w-3xl flex-col gap-4 px-7 py-7 phone:px-4 phone:py-5">
      <PageHeader title={title} actions={actions} />
      {children}
    </main>
  );

  if (load.kind === "missing")
    return frame(
      "Friend's Trade List",
      <p className="m-0 text-body text-text-muted">
        This collector isn't one of your Friends.
      </p>
    );
  if (load.kind === "failed")
    return frame(
      "Friend's Trade List",
      <div className="flex flex-wrap items-center gap-3">
        <p role="status" className="m-0 text-body text-text-muted">
          This Trade List couldn't be loaded.
        </p>
        <Button onClick={() => setAttempt((n) => n + 1)}>Retry</Button>
      </div>
    );
  if (load.kind === "loading")
    return frame(
      "Friend's Trade List",
      <p role="status" className="m-0 text-body text-text-muted">
        Loading cards…
      </p>
    );

  const { page, cards, more } = load;
  const name = page.display_name;
  // The answer on screen can be the previous search's for a moment after a search is typed.
  const current = load.q === q;
  const collection = friendCollectionPath(page.handle);
  return frame(
    `${name}'s Trade List`,
    <>
      <p className="m-0 text-meta text-text-muted">@{page.handle}</p>
      {trackRecord(page.completed_trades) !== null && (
        <p className="m-0 text-meta text-text-muted">
          {trackRecord(page.completed_trades)}
        </p>
      )}
      <SearchField
        label="Search by card name"
        placeholder="Search by card name"
        value={typed}
        onChange={(event) => setTyped(event.target.value)}
      />
      {cards.length === 0 ? (
        <p role="status" className="m-0 text-body text-text-muted">
          {load.q && !nothingListed
            ? "No cards match that name."
            : `${name} has nothing on their Trade List.`}
        </p>
      ) : (
        <div
          id={listId}
          aria-busy={!current}
          className="flex min-w-0 flex-col gap-4"
        >
          {groupByName(cards).map((group) => (
            <NameGroup key={group.name} name={group.name} cards={group.cards} />
          ))}
        </div>
      )}
      {page.next_page !== null && (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            aria-controls={listId}
            aria-disabled={more === "loading" || undefined}
            onClick={() => void showMore()}
          >
            Show more cards
          </Button>
          {more === "failed" && (
            <p role="alert" className="m-0 text-meta text-danger">
              More cards couldn't be loaded.
            </p>
          )}
        </div>
      )}
    </>,
    <>
      <a
        href={collection}
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey) return;
          event.preventDefault();
          onNavigate(collection);
        }}
        className={LINK}
      >
        See {name}'s Collection
      </a>
      <Button
        aria-label={`Propose trade to ${name}`}
        onClick={() => {
          proposeFromTradeList(
            page.trader_id,
            friendTradeListPath(page.handle)
          );
          onNavigate(proposalPath(page.trader_id));
        }}
      >
        Propose trade
      </Button>
    </>
  );
}

/** One card name on a Friend's Trade List, with each of its Editions and how many copies they offer. */
export function NameGroup({
  name,
  cards,
  action,
}: {
  name: string;
  cards: FriendTradeCard[];
  action?: (card: FriendTradeCard) => ReactNode;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h2
        id={headingId}
        className="m-0 text-heading font-semibold wrap-anywhere"
      >
        {name}
      </h2>
      <ul
        aria-label={name}
        className="m-0 list-none overflow-hidden rounded-panel border border-border bg-surface p-0"
      >
        {cards.map((card) => (
          <li
            key={card.edition_id}
            className={
              action
                ? "grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 border-b border-border px-4 py-3 last:border-b-0"
                : "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-border px-4 py-3 last:border-b-0"
            }
          >
            <span className="flex min-w-0 flex-col">
              <span className="text-body wrap-anywhere">{card.set_name}</span>
              <span className="text-meta text-text-muted tabular-nums wrap-anywhere">
                {card.set_code} {card.collector_number} ·{" "}
                {variantLabel(card.descriptor)}
              </span>
            </span>
            <span className="text-body font-semibold tabular-nums">
              ×{card.copies}
            </span>
            {action?.(card)}
          </li>
        ))}
      </ul>
    </section>
  );
}
