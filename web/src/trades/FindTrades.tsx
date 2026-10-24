import { useEffect, useId, useRef, useState } from "react";
import { useOpenFriends } from "../social/FriendsDrawer";
import {
  getTradeMatch,
  getTradeMatches,
  type TradeMatches,
} from "../social_generated";
import { Button } from "../ui/Button";
import { CardSearch } from "./CardSearch";
import { RETRY } from "./conversationMessages";
import { MatchRow } from "./MatchRow";
import { NearYou } from "./NearYou";
import { FRIENDS_HEADING } from "./nearYouMessages";
import { friendTradeListPath } from "./tradeListModel";

export { MatchSide } from "./MatchRow";

type Load =
  | { kind: "loading" }
  | { kind: "failed" }
  | { kind: "ready"; matches: TradeMatches };

/**
 * Find trades (Trading #276, prototype verdict variant A; Near you and card search #300), at /trades/find, in three
 * blocks. **Card search** comes first, so it stays reachable above up to 100 nearby rows: pick a card to see which
 * Friends and which collectors near you have it for trade. **Friends** is one row per Friend who matches, two-way
 * matches first, then Friends who have cards the collector wants, then Friends who want cards the collector has.
 * **Near you** is the same for nearby collectors who are not Friends (sorted by match kind, band and name), with a radius
 * choice, or a prompt to turn on open discovery while it is off. The two lists load independently, so a slow Near you
 * never delays Friends; one revision counter makes card search read again after a radius or status change.
 *
 * A row is a button that opens both sides, showing only the matched cards: **You get** (each marked Exact, Any finish
 * or Same name) and **You give**, each with the copies offered and how many are wanted ("6 wanted (2 for Decks)") and
 * whether the want is for Decks, for Trade Wants or both. A side past 20 cards has **Show N more**, which reads that
 * collector's whole row, moves focus to that side's heading when it arrives, and from then on the row's header and
 * counts come from that read. **Propose trade** opens the proposal builder to that collector empty (Trading #284),
 * where the matched cards are listed first; **Message** opens the conversation. Block and Report join a Near you row
 * through its menu (`NearRowMenu`, Trading #302 and #303). Nothing shows a price, a Location or a Deck, or a Handle,
 * zip code or distance of anyone who is not a Friend. It reads again each time it opens.
 */
export function FindTrades({
  onNavigate,
}: {
  onNavigate: (to: string) => void;
}) {
  const headingId = useId();
  const [discoveryRevision, setDiscoveryRevision] = useState(0);
  return (
    <>
      <CardSearch onNavigate={onNavigate} revision={discoveryRevision} />
      <section aria-labelledby={headingId} className="flex flex-col gap-3">
        <h2 id={headingId} className="m-0 text-heading font-semibold">
          {FRIENDS_HEADING}
        </h2>
        <FriendMatches onNavigate={onNavigate} />
      </section>
      <NearYou
        onNavigate={onNavigate}
        onDiscoveryChanged={() => setDiscoveryRevision((n) => n + 1)}
      />
    </>
  );
}

/** The Friends section's body: its own load, Retry, intro, rows, empty state and the no-Friends state. */
function FriendMatches({ onNavigate }: { onNavigate: (to: string) => void }) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    const controller = new AbortController();
    setLoad({ kind: "loading" });
    getTradeMatches(controller.signal)
      .then((matches) => {
        if (!controller.signal.aborted) setLoad({ kind: "ready", matches });
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoad({ kind: "failed" });
      });
    return () => controller.abort();
  }, [attempt]);

  if (load.kind === "loading")
    return (
      <p role="status" className="m-0 text-body text-text-muted">
        Loading matches…
      </p>
    );
  if (load.kind === "failed")
    return (
      <div className="flex flex-wrap items-center gap-3">
        <p role="status" className="m-0 text-body text-text-muted">
          Matches couldn't be loaded.
        </p>
        <Button onClick={() => setAttempt((n) => n + 1)}>{RETRY}</Button>
      </div>
    );
  const { matches } = load;
  if (!matches.has_friends) return <NeedsFriends />;
  const toggle = (id: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <>
      <p className="m-0 text-body text-text-muted">
        Friends who have cards you want, or want cards you have.
      </p>
      {matches.rows.length === 0 ? (
        <p role="status" className="m-0 text-body text-text-muted">
          None of your Friends has cards you want or wants yours yet.
        </p>
      ) : (
        <ul
          aria-label="Matches"
          className="m-0 flex list-none flex-col gap-3 p-0"
        >
          {matches.rows.map((row) => (
            <MatchRow
              key={row.collector_id}
              row={row}
              handle={row.handle}
              band={null}
              tradeListPath={friendTradeListPath(row.handle)}
              loadAll={(signal) => getTradeMatch(row.collector_id, signal)}
              open={open.has(row.collector_id)}
              onToggle={() => toggle(row.collector_id)}
              onNavigate={onNavigate}
            />
          ))}
        </ul>
      )}
    </>
  );
}

/** The empty state for a collector with no Friends (story 51): matching needs Friends, and Add a Friend opens the
 * Friends drawer. */
function NeedsFriends() {
  const headingId = useId();
  const openFriends = useOpenFriends();
  const add = useRef<HTMLButtonElement>(null);
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col items-start gap-3 rounded-panel border border-border bg-surface px-6 py-6 phone:px-4 phone:py-4"
    >
      <h3 id={headingId} className="m-0 text-heading font-semibold">
        Matching needs Friends
      </h3>
      <p className="m-0 text-body text-text-muted">
        Trading matches you with your Friends. Add a Friend to see who has cards
        you want.
      </p>
      {openFriends && (
        <Button ref={add} variant="primary" onClick={() => openFriends(add)}>
          Add a Friend
        </Button>
      )}
    </section>
  );
}
