import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { PageHeader } from "../shell/PageHeader";
import {
  getTraderMatch,
  getTraderTradeList,
  SocialError,
  type FriendTradeCard,
  type TraderMatchRow,
  type TraderTradeList,
} from "../social_generated";
import { Button } from "../ui/Button";
import { SearchField } from "../ui/SearchField";
import { CardMessageButton } from "./CardMessageButton";
import { UNAVAILABLE_NOTE } from "./conversationMessages";
import { MatchSide } from "./FindTrades";
import { NameGroup } from "./FriendTradeListPage";
import { proposeFromTradeList } from "./openProposal";
import {
  groupByName,
  proposalPath,
  traderTradeListPath,
} from "./tradeListModel";
import { TRADER_LIST_TITLE, traderMeta } from "./traderMessages";

type Load =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "failed" }
  | {
      kind: "ready";
      page: TraderTradeList;
      cards: FriendTradeCard[];
      more: "idle" | "loading" | "failed";
      /** The search the answer was read for. */
      q: string;
    };

// How long the search waits after the last keystroke before it reads again, as on a Friend's Trade List.
const SEARCH_DELAY_MS = 300;

/**
 * A stranger's Trade List (Trading #299), at /trades/trader/<trader id>: a collector in reach who is not a Friend,
 * addressed by trader id. It shows what a Friend's Trade List page shows (the cards grouped by card name, search,
 * **Show more cards**) under a meta line of their band and track record, then the "You give" side of their match row:
 * the cards from the reader's own Trade List that they want. It never names a Handle, a Collection or a zip code, and
 * each card has **Message**, which opens the conversation with this collector with a question about that card in the
 * composer (Trading #301). A trader id that is unknown, the reader's own, or out of reach gets one plain
 * sentence, whatever the reason.
 *
 * **Propose trade** opens the proposal builder to this collector; its back link returns here.
 */
export function TraderTradeListPage({
  traderId,
  onNavigate,
}: {
  traderId: string;
  onNavigate: (to: string) => void;
}) {
  const [typed, setTyped] = useState("");
  const [q, setQ] = useState("");
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  // Whether the first unfiltered answer for this collector listed nothing at all, so a search can't hide that.
  const [nothingListed, setNothingListed] = useState(false);
  const [match, setMatch] = useState<TraderMatchRow | null>(null);
  const listId = useId();
  const giveHeading = useRef<HTMLHeadingElement>(null);
  // Bumped each time the main read starts, so a Show more read begun under an earlier search is dropped on arrival.
  const generation = useRef(0);

  useEffect(() => {
    const timer = window.setTimeout(() => setQ(typed.trim()), SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [typed]);

  useEffect(() => setNothingListed(false), [traderId]);

  useEffect(() => {
    const controller = new AbortController();
    generation.current++;
    setLoad((current) =>
      current.kind === "ready" ? current : { kind: "loading" }
    );
    getTraderTradeList(traderId, { q }, controller.signal)
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
  }, [traderId, q, attempt]);

  // The "You give" side of the match row, read once per attempt. A failed read shows nothing.
  useEffect(() => {
    const controller = new AbortController();
    setMatch(null);
    getTraderMatch(traderId, controller.signal).then(
      (row) => {
        if (!controller.signal.aborted) setMatch(row);
      },
      () => {}
    );
    return () => controller.abort();
  }, [traderId, attempt]);

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
      const page = await getTraderTradeList(traderId, {
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
      TRADER_LIST_TITLE,
      <p className="m-0 text-body text-text-muted">{UNAVAILABLE_NOTE}</p>
    );
  if (load.kind === "failed")
    return frame(
      TRADER_LIST_TITLE,
      <div className="flex flex-wrap items-center gap-3">
        <p role="status" className="m-0 text-body text-text-muted">
          This Trade List couldn't be loaded.
        </p>
        <Button onClick={() => setAttempt((n) => n + 1)}>Retry</Button>
      </div>
    );
  if (load.kind === "loading")
    return frame(
      TRADER_LIST_TITLE,
      <p role="status" className="m-0 text-body text-text-muted">
        Loading cards…
      </p>
    );

  const { page, cards, more } = load;
  const name = page.display_name;
  const meta = traderMeta(page.band, page.completed_trades);
  // The answer on screen can be the previous search's for a moment after a search is typed.
  const current = load.q === q;
  return frame(
    `${name}'s Trade List`,
    <>
      {meta !== null && <p className="m-0 text-meta text-text-muted">{meta}</p>}
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
            <NameGroup
              key={group.name}
              name={group.name}
              cards={group.cards}
              action={(card) => (
                <CardMessageButton
                  traderId={traderId}
                  name={name}
                  card={card}
                  onNavigate={onNavigate}
                />
              )}
            />
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
      {match !== null && (
        <MatchSide
          level={2}
          title="You give"
          label={`You give ${name}`}
          cards={match.you_give}
          more={0}
          busy={false}
          headingRef={giveHeading}
          onShowMore={() => {}}
        />
      )}
    </>,
    <Button
      aria-label={`Propose trade to ${name}`}
      onClick={() => {
        proposeFromTradeList(traderId, traderTradeListPath(traderId));
        onNavigate(proposalPath(traderId));
      }}
    >
      Propose trade
    </Button>
  );
}
