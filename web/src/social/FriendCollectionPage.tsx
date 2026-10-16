import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { PageHeader } from "../shell/PageHeader";
import {
  getFriendCollection,
  SocialError,
  type FriendCard,
  type FriendCollection,
} from "../social_generated";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { Pill } from "../ui/Pill";
import { SearchField } from "../ui/SearchField";
import { variantLabel } from "../ui/variantLabel";
import { readPrintings } from "./friendCards";

type Show = FriendCollection["show"];

type Load =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "failed" }
  | {
      kind: "ready";
      page: FriendCollection;
      cards: FriendCard[];
      more: "idle" | "loading" | "failed";
    };

// How long the search waits after the last keystroke before it reads again.
const SEARCH_DELAY_MS = 300;

/**
 * A Friend's Collection (social network #250, spec "Web screens", Friends' cards verdict): the cards one Friend could
 * lend now, opened from the Friends drawer at /friends/<Handle>. Each card says "N spare" or "N in a Deck"; no Location
 * or Deck of theirs is ever named. **On my Want List** (the default) shows the cards that match what the collector's
 * Decks still need, under the device's owned-cards choice (`readPrintings`); **All cards** shows every card and marks
 * those with "Want". Search narrows by name. Pages hold whole cards (every Edition of a card together), and **Show
 * more cards** reads the next page. A Handle that isn't one of the collector's Friends gets one plain sentence, the
 * same whatever the reason.
 *
 * Asking to borrow arrives with Borrow Requests (#252): it passes each tile an `action`.
 */
export function FriendCollectionPage({ handle }: { handle: string }) {
  const printings = useMemo(readPrintings, []);
  const [show, setShow] = useState<Show>("wanted");
  const [typed, setTyped] = useState("");
  const [q, setQ] = useState("");
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const listId = useId();

  useEffect(() => {
    const timer = window.setTimeout(() => setQ(typed.trim()), SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [typed]);

  useEffect(() => {
    const controller = new AbortController();
    setLoad((current) =>
      current.kind === "ready" ? current : { kind: "loading" }
    );
    getFriendCollection(handle, { show, q, printings }, controller.signal)
      .then((page) =>
        setLoad({ kind: "ready", page, cards: page.cards, more: "idle" })
      )
      .catch((cause) => {
        if (controller.signal.aborted) return;
        setLoad(
          cause instanceof SocialError && cause.status === 404
            ? { kind: "missing" }
            : { kind: "failed" }
        );
      });
    return () => controller.abort();
  }, [handle, show, q, printings, attempt]);

  async function showMore() {
    if (load.kind !== "ready" || load.page.next_page === null) return;
    const current = load;
    setLoad({ ...current, more: "loading" });
    try {
      const page = await getFriendCollection(handle, {
        show,
        q,
        printings,
        page: current.page.next_page!,
      });
      setLoad({
        kind: "ready",
        page,
        cards: [...current.cards, ...page.cards],
        more: "idle",
      });
    } catch {
      setLoad({ ...current, more: "failed" });
    }
  }

  const frame = (title: string, children: ReactNode) => (
    <main className="mx-auto box-border flex max-w-7xl flex-col gap-4 px-7 py-7 phone:px-4 phone:py-5">
      <PageHeader title={title} />
      {children}
    </main>
  );

  if (load.kind === "missing")
    return frame(
      "Friend's Collection",
      <p className="m-0 text-body text-text-muted">
        This collector isn't one of your Friends.
      </p>
    );
  if (load.kind === "failed")
    return frame(
      "Friend's Collection",
      <div className="flex flex-wrap items-center gap-3">
        <p role="status" className="m-0 text-body text-text-muted">
          These cards couldn't be loaded.
        </p>
        <Button onClick={() => setAttempt((n) => n + 1)}>Retry</Button>
      </div>
    );
  if (load.kind === "loading")
    return frame(
      "Friend's Collection",
      <p role="status" className="m-0 text-body text-text-muted">
        Loading cards…
      </p>
    );

  const { page, cards, more } = load;
  const name = page.display_name;
  // The answer on screen can be the previous filter's for a moment after a chip is pressed or a search is typed.
  const current = page.show === show;
  const empty = q
    ? `No cards match “${q}”.`
    : page.show === "wanted"
      ? `${name} has no cards from your Want List to lend right now.`
      : `${name} has no cards to lend right now.`;
  return frame(
    name,
    <>
      <p className="m-0 text-meta text-text-muted">
        @{page.handle} · Cards they could lend now
      </p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div
          role="group"
          aria-label="Show cards"
          className="flex flex-wrap items-center gap-1"
        >
          <Chip selected={show === "wanted"} onChange={() => setShow("wanted")}>
            On my Want List
          </Chip>
          <Chip selected={show === "all"} onChange={() => setShow("all")}>
            All cards
          </Chip>
        </div>
        <div className="min-w-0 flex-1 basis-56 phone:basis-full">
          <SearchField
            label={`Search ${name}'s cards`}
            placeholder={`Search ${name}'s cards`}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
          />
        </div>
      </div>
      {cards.length === 0 ? (
        <p role="status" className="m-0 text-body text-text-muted">
          {empty}
        </p>
      ) : (
        <ul
          id={listId}
          aria-label={`${name}'s cards`}
          aria-busy={!current}
          className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-4 p-0 phone:grid-cols-2 phone:gap-3"
        >
          {cards.map((card) => (
            <FriendCardTile
              key={card.edition_id}
              card={card}
              markWanted={page.show === "all"}
            />
          ))}
        </ul>
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
              More cards couldn't be loaded. Please retry.
            </p>
          )}
        </div>
      )}
    </>
  );
}

/**
 * One card a Friend could lend: its art, name, set, number and Variant, and "N spare" or "N in a Deck". With
 * `markWanted`, a card that matches the Want List says "Want". `action` sits under it: Ask to borrow, from #252.
 */
export function FriendCardTile({
  card,
  markWanted,
  action,
}: {
  card: FriendCard;
  markWanted: boolean;
  action?: ReactNode;
}) {
  const variant = variantLabel(card.descriptor);
  return (
    <li className="flex min-w-0 flex-col gap-1">
      <CardImage url={card.image_url} />
      <span className="truncate text-caption font-medium">{card.name}</span>
      <span className="truncate text-micro text-text-subtle tabular-nums">
        {card.set_code} {card.collector_number} · {variant}
      </span>
      <span className="flex flex-wrap gap-1">
        {card.spare !== "0" && <Pill>{card.spare} spare</Pill>}
        {card.in_deck !== "0" && <Pill>{card.in_deck} in a Deck</Pill>}
        {markWanted && card.wanted && <Pill tone="ok">Want</Pill>}
      </span>
      {action}
    </li>
  );
}

/** The card's small artwork, or "Artwork unavailable" when there is none or it fails. The Want List's Get from Friends
 * panels (#251) draw it too. */
export function CardImage({ url }: { url: string | null }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  return (
    <span
      aria-hidden="true"
      className="block aspect-(--tile-aspect) w-full overflow-hidden rounded-card bg-surface-raised"
    >
      {url && !failed ? (
        <img
          src={url}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setFailed(true)}
          className="block size-full object-cover"
        />
      ) : (
        <span className="box-border flex h-full items-center justify-center p-2 text-center text-caption text-text-muted">
          Artwork unavailable
        </span>
      )}
    </span>
  );
}
