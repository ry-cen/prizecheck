import { useEffect, useId, useRef, useState, type MouseEvent } from "react";
import {
  discoverDecks,
  DiscoveryError,
  type DiscoverFormat,
  type PublicDeckSummary,
} from "../discovery_generated";
import { followLink } from "../public/publicRoutes";
import { PageHeader } from "../shell/PageHeader";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { Pill } from "../ui/Pill";
import { SearchField } from "../ui/SearchField";
import { useDebouncedValue } from "../workspace/useDebouncedValue";
import {
  costText,
  FORMAT_CHIPS,
  FORMAT_LABELS,
  publishedDate,
} from "./discoverText";

const SEARCH_DELAY_MS = 250;
const CHANGED = "Published decks changed. Showing the first page.";
const UNAVAILABLE = "Discover is unavailable right now. Please retry.";

type Props = {
  /** Opens another address in the app without a page load (a deck card's Published Deck). */
  onNavigate: (to: string) => void;
};

/**
 * Discover (#182, spec "Published Deck and Discover"): a grid of deck cards, newest first, from the listing of
 * Listed Published Decks that are legal in their Target Format today. One search box (title or card name) and the
 * format chips (Any, Standard, Expanded, GLC) narrow it on the server; More decks loads the next 30. The same page
 * shows under the public header signed out and inside the shell signed in. It has no dialogs.
 */
export function DiscoverPage({ onNavigate }: Props) {
  const [text, setText] = useState("");
  const q = useDebouncedValue(text.trim(), SEARCH_DELAY_MS);
  const [format, setFormat] = useState<DiscoverFormat | null>(null);
  const found = useDiscover(q, format);
  const follow = followLink(onNavigate);
  const count = found.decks.length;
  const line = found.loading
    ? "Loading decks…"
    : found.error
      ? ""
      : count === 0
        ? q || format
          ? "No legal decks match this search."
          : "No decks are listed yet."
        : `Showing ${count.toLocaleString("en-US")} ${count === 1 ? "deck" : "decks"}`;
  return (
    <main className="mx-auto box-border flex w-full max-w-7xl min-w-0 flex-col gap-4 px-7 py-7 phone:px-4 phone:py-5">
      <div className="flex flex-col gap-1">
        <PageHeader title="Discover decks" />
        <p className="m-0 -mt-4 text-body text-text-muted">
          Decks collectors have published, each legal in its format today.
        </p>
      </div>
      <SearchField
        label="Search decks"
        placeholder="Deck title or card name"
        value={text}
        maxLength={120}
        onChange={(event) => setText(event.target.value)}
      />
      <div
        role="group"
        aria-label="Format"
        className="flex min-w-0 flex-wrap items-center gap-1.5"
      >
        <Chip selected={format === null} onChange={() => setFormat(null)}>
          Any
        </Chip>
        {FORMAT_CHIPS.map((option) => (
          <Chip
            key={option}
            selected={format === option}
            onChange={(on) => setFormat(on ? option : null)}
          >
            {FORMAT_LABELS[option]}
          </Chip>
        ))}
      </div>
      <p role="status" className="m-0 text-meta text-text-muted">
        {[found.notice, line].filter(Boolean).join(" ")}
      </p>
      {found.error && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 text-body text-danger"
        >
          <p className="m-0">{found.error}</p>
          <Button onClick={found.retry}>Retry</Button>
        </div>
      )}
      {count > 0 && (
        <ul
          aria-label="Decks"
          aria-busy={found.loading || found.loadingMore}
          className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(12.5rem,1fr))] gap-4 p-0 phone:grid-cols-2 phone:gap-3"
        >
          {found.decks.map((deck) => (
            <li key={deck.url} className="min-w-0">
              <DeckCard deck={deck} onFollow={follow} />
            </li>
          ))}
        </ul>
      )}
      {found.next && (
        <Button
          className="self-center"
          disabled={found.loadingMore}
          onClick={() => void found.loadMore()}
        >
          More decks
        </Button>
      )}
    </main>
  );
}

/**
 * One deck card, a link to its Published Deck: the featured card, the title, the ✓ Target Format pill, the card
 * count, the published date and the cost. The link is named by the title alone and described by the rest.
 */
function DeckCard({
  deck,
  onFollow,
}: {
  deck: PublicDeckSummary;
  onFollow: (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  const titleId = useId();
  const detailsId = useId();
  const cost = costText(deck.cost);
  const [failed, setFailed] = useState(false);
  return (
    <a
      href={deck.url}
      onClick={onFollow}
      aria-labelledby={titleId}
      aria-describedby={detailsId}
      className="box-border flex h-full min-w-0 flex-col gap-2 rounded-card border border-border bg-surface p-3 text-text no-underline hover:border-control-outline"
    >
      <span className="block aspect-[4/3] w-full overflow-hidden rounded-card bg-[linear-gradient(135deg,var(--color-art-start),var(--color-art-end))]">
        {deck.image_url && !failed ? (
          <img
            src={deck.image_url}
            alt={deck.featured_name ?? ""}
            loading="lazy"
            decoding="async"
            draggable={false}
            onError={() => setFailed(true)}
            className="block size-full object-cover object-top"
          />
        ) : (
          <span className="box-border flex h-full items-center justify-center p-2 text-center text-caption text-text-muted">
            Artwork unavailable
          </span>
        )}
      </span>
      <h2 id={titleId} className="m-0 line-clamp-2 text-body font-semibold">
        {deck.title}
      </h2>
      <span id={detailsId} className="flex min-w-0 flex-col gap-1.5">
        <span className="flex flex-wrap items-center gap-1.5">
          <Pill tone="ok">
            <span aria-hidden="true">✓&nbsp;</span>
            {FORMAT_LABELS[deck.target_format]}
            <span className="sr-only"> legal,</span>
          </Pill>
          <span className="text-meta text-text-muted">{deck.total} cards</span>
        </span>
        <span className="text-meta text-text-muted">
          Published {publishedDate(deck.published_at)}
        </span>
        <span
          title={cost.note ?? undefined}
          className={
            cost.muted
              ? "text-meta text-text-muted"
              : "text-body font-semibold text-text"
          }
        >
          {cost.text}
          {cost.note && <span className="sr-only"> ({cost.note})</span>}
        </span>
      </span>
    </a>
  );
}

type Listing = {
  decks: PublicDeckSummary[];
  next: string | null;
  loading: boolean;
  loadingMore: boolean;
  error: string;
  notice: string;
};

/** The listing for a search and a format: page one on every change, and the next page on request. A page whose
 * cursor went stale (another deck was published or delisted) starts again at page one with a notice. */
function useDiscover(q: string, format: DiscoverFormat | null) {
  const [listing, setListing] = useState<Listing>({
    decks: [],
    next: null,
    loading: true,
    loadingMore: false,
    error: "",
    notice: "",
  });
  const [attempt, setAttempt] = useState(0);
  // Bumped by every page-one load, so an answer for an older search is dropped.
  const generation = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    const mine = ++generation.current;
    setListing((previous) => ({
      ...previous,
      loading: true,
      loadingMore: false,
      error: "",
      notice: "",
    }));
    discoverDecks(q, undefined, format, controller.signal)
      .then((page) => {
        if (mine === generation.current)
          setListing({
            decks: page.decks,
            next: page.next_cursor,
            loading: false,
            loadingMore: false,
            error: "",
            notice: "",
          });
      })
      .catch(() => {
        if (!controller.signal.aborted && mine === generation.current)
          setListing({
            decks: [],
            next: null,
            loading: false,
            loadingMore: false,
            error: UNAVAILABLE,
            notice: "",
          });
      });
    return () => controller.abort();
  }, [q, format, attempt]);

  async function loadMore() {
    const cursor = listing.next;
    if (!cursor || listing.loadingMore) return;
    const mine = generation.current;
    setListing((previous) => ({ ...previous, loadingMore: true, error: "" }));
    try {
      const page = await discoverDecks(q, cursor, format);
      if (mine === generation.current)
        setListing((previous) => ({
          ...previous,
          decks: [...previous.decks, ...page.decks],
          next: page.next_cursor,
          loadingMore: false,
        }));
    } catch (cause) {
      if (mine !== generation.current) return;
      const changed =
        cause instanceof DiscoveryError &&
        (cause.code === "DISCOVERY_CHANGED" || cause.code === "INVALID_CURSOR");
      if (!changed) {
        setListing((previous) => ({
          ...previous,
          loadingMore: false,
          error: UNAVAILABLE,
        }));
        return;
      }
      try {
        const page = await discoverDecks(q, undefined, format);
        if (mine === generation.current)
          setListing({
            decks: page.decks,
            next: page.next_cursor,
            loading: false,
            loadingMore: false,
            error: "",
            notice: CHANGED,
          });
      } catch {
        if (mine === generation.current)
          setListing((previous) => ({
            ...previous,
            loadingMore: false,
            error: UNAVAILABLE,
          }));
      }
    }
  }

  return { ...listing, loadMore, retry: () => setAttempt((n) => n + 1) };
}
