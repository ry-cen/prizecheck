import {
  useEffect,
  useId,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { ChevronRight } from "lucide-react";
import { COUNTING_OPTIONS } from "../settings/wantListCounting";
import type { FriendCopy } from "../social_generated";
import { useFriendMatches } from "../social/useFriendMatches";
import { FriendChips, GetFromFriends } from "../social/WantListFriends";
import {
  AskChip,
  AskControl,
  copyCap,
  copyCard,
  useBorrowDrafts,
} from "../loans/BorrowDrafts";
import { lendableText } from "../social/friendCards";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { Icon } from "../ui/Icon";
import { Segmented } from "../ui/Segmented";
import { MOBILE_QUERY, useMediaQuery } from "../workspace/media";
import {
  getWantList,
  WantListError,
  type CombinedRow,
  type WantList,
  type WantListLine,
  type WantListSection,
} from "../want_list_generated";
import {
  cards,
  countedText,
  editionText,
  scopeInAddress,
  wantListPath,
} from "./wantListModel";
import { WantListBuy } from "./WantListBuy";
import {
  CostSummary,
  LineCost,
  RowCost,
  SectionCost,
  useTotalCostSuffix,
  useWantListCost,
  WantListCostContext,
} from "./WantListCost";
import { SwapHint } from "./SwapHint";
import { useWantListSwap, type WantListSwap } from "./useWantListSwap";
import { CopyArt } from "../ui/CopyTile";
import {
  TradeWantsPanel,
  WillAcceptSelect,
  WillAcceptRadios,
} from "./TradeWantsPanel";
import { useTradeWants, type TradeWantsApi } from "./useTradeWants";
import { pendingText } from "./pendingLoans";
import {
  usePendingLoans,
  wantListPins,
  type PendingApi,
} from "./usePendingLoans";

type Props = {
  /** Opens a Deck in the deck builder (/decks/<id>). */
  onOpenDeck: (id: string) => void;
  /** Goes to another address in the app: Settings, or the scoped Want List's own address (replaced, not pushed). */
  onNavigate: (to: string, options?: { replace?: boolean }) => void;
};

type Load =
  { kind: "loading" } | { kind: "ready"; list: WantList } | { kind: "failed" };

/** The summary's switch (#251): the Want List as a shopping list, or as what Friends can lend. */
type View = "buy" | "friends";
const VIEWS = [
  { value: "buy", label: "Buy" },
  { value: "friends", label: "Get from Friends" },
] as const;
const NO_COPIES = new Map<string, FriendCopy[]>();

const LINK =
  "inline-flex h-control items-center gap-1 rounded-control px-2 text-control font-medium text-accent-strong no-underline hover:bg-surface-raised phone:h-control-phone";

/** Follows an in-app link without a page load, unless a modifier asks for a new tab or window. */
function follow(event: MouseEvent, go: () => void) {
  if (event.metaKey || event.ctrlKey || event.shiftKey) return;
  event.preventDefault();
  go();
}

/**
 * The Want List view inside Decks (decklist import #209; spec "The Want List page"): what every Deck still needs from
 * outside the Collection under the account's counting setting (GET /api/want-list).
 *
 * - **Summary:** the cards to get, and the counting as text with a link to Settings.
 * - **Deck chips:** All Decks or one Deck. The scope is `?deck=<id>` in the address, replaced rather than pushed, so a
 *   reload keeps it; the address bar's path doesn't change, so the scope lives in this view's state.
 * - **Sections:** one per Deck, oldest first, listing the lines that still need copies with "N of M" and where the
 *   counted copies are; a Deck that needs nothing collapses to "Nothing to get". Open Deck goes to the builder.
 * - **Combined total:** each card once with the Decks that need it. A sticky right column on desktop and a collapsed
 *   row under the summary on a phone; hidden when the view is scoped to one Deck.
 * - **Cost (#210):** the estimated cost and cards priced in the summary, and each section's, line's and combined row's
 *   cost, from one price access per answer (WantListCost) read after the page draws; **Buy on TCGplayer** exports what
 *   the page shows (WantListBuy).
 * - **Swap (#211):** a line that can use copies of another Edition the collector owns says so, and Swap changes that many
 *   copies of the line to it in one Deck List batch, with Undo in a toast (`useWantListSwap`). The Want List is read
 *   again after it, and the new answer's `deck_lists_digest` makes the cost re-pair.
 * - **Friends' cards (#251):** a line a Friend can lend shows Friend chips, and the summary's **Buy / Get from Friends**
 *   switch shows one panel per card instead of the sections (`WantListFriends`). Both read Friends' cards apart from
 *   the Want List (`useFriendMatches`), so nothing above waits on them; without Friends there is no switch.
 * - **Trading (#275):** each line has a Will accept select (this exact card, any finish, or any card with the same
 *   name), which reads the Want List again because the Swap hints follow it; and All Decks ends with the Trade Wants
 *   panel (`useTradeWants`), shown even without Decks. Neither changes a figure on the page.
 */
export function WantListView({ onOpenDeck, onNavigate }: Props) {
  const idBase = useId();
  const phone = useMediaQuery(MOBILE_QUERY);
  const [scope, setScope] = useState<string | null>(scopeInAddress);
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [notice, setNotice] = useState("");
  const reload = () => setAttempt((n) => n + 1);
  // #210: the cost of the answer on the page, read once it has drawn.
  const cost = useWantListCost(
    load.kind === "ready" ? load.list : null,
    reload
  );
  const swap = useWantListSwap({
    list: load.kind === "ready" ? load.list : null,
    failed: load.kind === "failed",
    reload,
    notify: setNotice,
  });
  const friends = useFriendMatches(
    load.kind === "ready" ? load.list : null,
    attempt
  );
  const drafts = useBorrowDrafts();
  const trade = useTradeWants(reload);
  // What a scoped Deck is waiting on from Friends, read apart from the Want List; All Decks reads none. The answer's
  // own pins read it again when a Swap or a reload brings a new Want List, never the other way round.
  const friendRequests = usePendingLoans(
    load.kind === "ready" ? load.list.deck_id : null,
    load.kind === "ready" ? wantListPins(load.list) : ""
  );
  const [view, setView] = useState<View>("buy");

  function choose(deckId: string | null) {
    setNotice("");
    setScope(deckId);
    onNavigate(wantListPath(deckId), { replace: true });
  }

  // An address whose Deck isn't an id reads as All Decks; the address says so too.
  useEffect(() => {
    if (scope === null && window.location.search.includes("deck="))
      onNavigate(wantListPath(null), { replace: true });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoad((previous) =>
      previous.kind === "ready" ? previous : { kind: "loading" }
    );
    getWantList(scope, controller.signal)
      .then((list) => setLoad({ kind: "ready", list }))
      .catch((cause) => {
        if (controller.signal.aborted) return;
        if (
          scope &&
          cause instanceof WantListError &&
          (cause.code === "DECK_NOT_FOUND" || cause.status === 422)
        ) {
          choose(null);
          setNotice("That Deck wasn't found. Showing All Decks.");
        } else setLoad({ kind: "failed" });
      });
    return () => controller.abort();
  }, [scope, attempt]);

  if (load.kind === "loading")
    return (
      <p role="status" className="m-0 text-body text-text-muted">
        Loading the Want List…
      </p>
    );
  if (load.kind === "failed")
    return (
      <div className="flex flex-wrap items-center gap-3">
        <p role="status" className="m-0 text-body text-text-muted">
          The Want List couldn't be loaded.
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

  const { list } = load;
  // The answer on screen can belong to the previous scope for a moment after a chip is pressed, so what it is
  // labelled and laid out as follows the scope it answers (`shownScope`), never the pressed chip.
  const shownScope = list.deck_id;
  const current = shownScope === scope;
  const names = new Map(list.decks.map((deck) => [deck.id, deck.name]));
  const deckName = (id: string) => names.get(id) ?? "another Deck";
  const scoped = shownScope ? (names.get(shownScope) ?? null) : null;
  const counting = COUNTING_OPTIONS.find(
    (option) => option.value === list.want_list_counting
  )!;
  const hasFriends = friends.kind === "ready" && friends.hasFriends;
  const byCard = friends.kind === "ready" ? friends.byCard : NO_COPIES;
  const pending = friends.kind === "ready" && friends.pending;
  const shownView: View = hasFriends ? view : "buy";

  if (list.decks.length === 0)
    return (
      <div className="flex min-w-0 flex-col gap-4">
        <p className="m-0 text-body text-text-muted">
          No Decks yet. Create one on My Decks, and the Want List shows what it
          still needs.
        </p>
        <TradeWantsPanel api={trade} />
      </div>
    );

  const page = (
    <div className="flex min-w-0 flex-col gap-4" aria-busy={!current}>
      <section
        aria-labelledby={`${idBase}-summary`}
        className="flex flex-wrap items-end gap-x-8 gap-y-2 rounded-panel border border-border bg-surface p-4"
      >
        <h2
          id={`${idBase}-summary`}
          className="m-0 basis-full text-heading font-semibold wrap-anywhere"
        >
          {scoped ? `Want List · ${scoped}` : "Want List"}
        </h2>
        <p className="m-0 flex flex-col">
          <span className="text-meta text-text-muted wrap-anywhere">
            {scoped ? `${scoped} needs` : "To get"}
          </span>
          <span className="text-display font-semibold tabular-nums">
            {cards(list.to_get)}
          </span>
        </p>
        <CostSummary />
        <WantListBuy list={list} onChanged={reload} />
        {hasFriends && (
          <div className="self-center phone:basis-full">
            <Segmented
              mode="choice"
              label="Show the Want List as"
              options={VIEWS}
              value={view}
              onChange={setView}
            />
          </div>
        )}
        <p className="m-0 basis-full text-meta text-text-muted">
          Counting:{" "}
          <strong className="font-semibold text-text">{counting.label}</strong>.{" "}
          {counting.explainer}{" "}
          <a
            href="/settings"
            onClick={(event) => follow(event, () => onNavigate("/settings"))}
            className="text-accent-strong underline"
          >
            Change it in Settings
          </a>
        </p>
      </section>
      <div
        role="group"
        aria-label="Show Decks"
        className="flex flex-wrap items-center gap-1 border-b border-border pb-3"
      >
        <Chip selected={scope === null} onChange={() => choose(null)}>
          All Decks
        </Chip>
        {list.decks.map((deck) => (
          <Chip
            key={deck.id}
            selected={scope === deck.id}
            onChange={() => choose(deck.id)}
          >
            {deck.name}
          </Chip>
        ))}
      </div>
      <p role="status" className="m-0 text-body text-warning empty:sr-only">
        {notice}
      </p>
      {shownView === "friends" ? (
        <GetFromFriends
          rows={list.combined}
          byCard={byCard}
          deckName={deckName}
          scoped={scoped}
          pending={pending}
          action={(row, copy) => (
            <AskControl
              friend={copy}
              card={copyCard(
                copy,
                copy.edition_id === row.edition_id ? row.image_url : null
              )}
              cap={copyCap(copy)}
              lendable={lendableText(copy)}
              deckId={shownScope}
            />
          )}
          asked={
            drafts
              ? (_row, copies) =>
                  copies.reduce(
                    (total, copy) =>
                      total +
                      drafts.quantity(copy.collector_id, copy.edition_id),
                    0
                  )
              : undefined
          }
        />
      ) : (
        <div
          className={
            shownScope
              ? "flex min-w-0 flex-col gap-4"
              : "grid grid-cols-[minmax(0,1fr)_18rem] items-start gap-6 phone:grid-cols-1 phone:gap-4"
          }
        >
          {!shownScope && (
            <CombinedTotal
              rows={list.combined}
              toGet={list.to_get}
              phone={phone}
              deckName={deckName}
            />
          )}
          <div className="col-start-1 row-start-1 flex min-w-0 flex-col gap-4 phone:row-start-2">
            {list.sections.map((section) => (
              <DeckSection
                key={section.deck_id}
                section={section}
                deckName={deckName}
                onOpenDeck={onOpenDeck}
                swap={swap}
                byCard={byCard}
                trade={trade}
                borrowFor={shownScope}
                pending={friendRequests}
              />
            ))}
            {!shownScope && <TradeWantsPanel api={trade} />}
          </div>
        </div>
      )}
    </div>
  );
  return (
    <WantListCostContext.Provider value={cost}>
      {page}
    </WantListCostContext.Provider>
  );
}

function DeckSection({
  section,
  deckName,
  onOpenDeck,
  swap,
  byCard,
  trade,
  borrowFor,
  pending,
}: {
  section: WantListSection;
  deckName: (id: string) => string;
  onOpenDeck: (id: string) => void;
  swap: WantListSwap;
  /** Friends' copies by the card they match (#251). */
  byCard: Map<string, FriendCopy[]>;
  /** The collector's Will accept choices (#275). */
  trade: TradeWantsApi;
  /** The Deck a new Borrow Request draft is For, or null (NeededLines). */
  borrowFor: string | null;
  /** What the scoped Deck is waiting on from Friends. */
  pending: PendingApi;
}) {
  const idBase = useId();
  return (
    <section
      aria-labelledby={`${idBase}-deck`}
      className="rounded-panel border border-border bg-surface"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2">
        <h3
          id={`${idBase}-deck`}
          className="m-0 min-w-0 flex-1 text-body font-semibold wrap-anywhere"
        >
          {section.name}
        </h3>
        {section.to_get !== "0" && (
          <span className="text-meta tabular-nums text-text-muted">
            {cards(section.to_get)} to get
          </span>
        )}
        <SectionCost deckId={section.deck_id} />
        <a
          href={`/decks/${encodeURIComponent(section.deck_id)}`}
          onClick={(event) => follow(event, () => onOpenDeck(section.deck_id))}
          aria-label={`Open Deck ${section.name}`}
          className={LINK}
        >
          Open Deck
          <Icon icon={ChevronRight} />
        </a>
      </div>
      {section.lines.length === 0 ? (
        <p className="m-0 border-t border-border px-4 py-3 text-body text-text-muted">
          <span aria-hidden="true">✓ </span>Nothing to get
        </p>
      ) : (
        <NeededLines
          layout="tiles"
          section={section}
          deckName={deckName}
          swap={swap}
          byCard={byCard}
          trade={trade}
          borrowFor={borrowFor}
          pending={pending}
        />
      )}
    </section>
  );
}

/**
 * A section's lines that still need copies (#209), each with its Will accept select (#275), Swap hint (#211) and Friend
 * chips with Ask (#251). The Want List's Deck sections and the deck builder's Ways to get missing cards panel draw them.
 * A chip that starts a Friend's Borrow Request draft makes it For `borrowFor`: the section's Deck where the page is
 * about that one Deck, and none on All Decks.
 */
export function NeededLines({
  layout = "rows",
  section,
  deckName,
  swap,
  byCard,
  trade,
  borrowFor,
  pending,
}: {
  layout?: "rows" | "tiles";
  section: WantListSection;
  deckName: (id: string) => string;
  swap: WantListSwap;
  /** Friends' copies by the card they match (#251). */
  byCard: Map<string, FriendCopy[]>;
  /** The collector's Will accept choices (#275). */
  trade: TradeWantsApi;
  /** The Deck a new Borrow Request draft is For, or null for none. */
  borrowFor: string | null;
  /** What this Deck is waiting on from Friends, when it is the Deck in scope: shown beside each line's counts and
   * never taken off them. */
  pending?: PendingApi;
}) {
  const waiting =
    pending &&
    pending.state.kind !== "idle" &&
    pending.state.deckId === section.deck_id
      ? pending.state
      : null;
  return (
    <>
      {waiting &&
        (waiting.kind === "failed" ||
          (waiting.kind === "ready" && waiting.stale)) && (
          <p
            role="status"
            className="m-0 flex flex-wrap items-center gap-2 border-t border-border px-4 py-2 text-meta text-text-muted"
          >
            {waiting.kind === "failed"
              ? "Requests to Friends couldn't be loaded."
              : "Requests to Friends may be out of date."}
            <Button onClick={pending!.retry}>Retry</Button>
          </p>
        )}
      <ul
        aria-label={`What ${section.name} needs`}
        className={
          layout === "tiles"
            ? "m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4 border-t border-border p-4 phone:grid-cols-1 phone:gap-3 phone:p-3"
            : "m-0 list-none border-t border-border p-0"
        }
      >
        {section.lines.map((line) => (
          <NeededLine
            layout={layout}
            key={line.edition_id}
            deckId={section.deck_id}
            line={line}
            deckName={deckName}
            accept={
              layout === "tiles" ? (
                <WillAcceptRadios line={line} api={trade} />
              ) : (
                <WillAcceptSelect line={line} api={trade} />
              )
            }
            pendingNote={
              waiting?.kind === "ready"
                ? pendingText(waiting.lines.get(line.edition_id))
                : ""
            }
          >
            <SwapHint
              compact={layout === "tiles"}
              section={section}
              line={line}
              swap={swap}
              rule={
                trade.state.kind === "ready"
                  ? trade.state.rules.get(line.edition_id)
                  : undefined
              }
            />
            <FriendChips
              name={line.name}
              edition={editionText(line)}
              wanted={line.edition_id}
              copies={byCard.get(line.edition_id)}
              chip={(copy, text) => (
                <AskChip
                  friend={copy}
                  card={copyCard(
                    copy,
                    copy.edition_id === line.edition_id ? line.image_url : null
                  )}
                  cap={copyCap(copy)}
                  lendable={lendableText(copy)}
                  text={text}
                  deckId={borrowFor}
                />
              )}
            />
          </NeededLine>
        ))}
      </ul>
    </>
  );
}

function NeededLine({
  layout = "rows",
  deckId,
  line,
  deckName,
  accept,
  pendingNote = "",
  children,
}: {
  layout?: "rows" | "tiles";
  deckId: string;
  line: WantListLine;
  deckName: (id: string) => string;
  /** The line's Will accept select (#275), under its card's name. */
  accept?: ReactNode;
  /** What Friends were asked for or agreed to lend of this card for this Deck, under its counts; "" for none. */
  pendingNote?: string;
  /** The line's Swap hint (#211) and Friend chips (#251), under its card and counts. */
  children?: ReactNode;
}) {
  if (layout === "tiles")
    return (
      <li className="min-w-0 rounded-card border border-border p-2 phone:grid phone:grid-cols-[64px_minmax(0,1fr)] phone:items-start phone:gap-3">
        <CopyArt
          name={line.name}
          imageUrl={line.image_url}
          className="mx-auto w-(--tile-medium) max-w-full phone:w-full"
        />
        <div className="min-w-0">
          <p className="m-0 mt-2 text-body font-semibold wrap-anywhere phone:mt-0">
            {line.name}
          </p>
          <p className="m-0 text-meta text-text-muted wrap-anywhere">
            {editionText(line)}
          </p>
          <p className="m-0 text-heading font-semibold tabular-nums text-accent-strong">
            ×{line.need}{" "}
            <span className="text-meta font-normal text-text-muted">
              of {line.quantity}
            </span>
          </p>
          <LineCost deckId={deckId} editionId={line.edition_id} compact />
          <p className="m-0 text-meta text-text-muted wrap-anywhere">
            {countedText(line, deckName)}
          </p>
          {pendingNote && (
            <p className="m-0 text-meta text-text-muted wrap-anywhere">
              {pendingNote}
            </p>
          )}
          {accept}
          <div className="mt-2 flex min-w-0 flex-col gap-2">{children}</div>
        </div>
      </li>
    );
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-1 border-b border-border px-4 py-3 last:border-b-0 phone:grid-cols-1">
      <div className="min-w-0">
        <p className="m-0 text-body font-medium wrap-anywhere">{line.name}</p>
        <p className="m-0 text-meta text-text-muted wrap-anywhere">
          {editionText(line)}
        </p>
        {accept}
      </div>
      <div className="min-w-0 text-right phone:text-left">
        <p className="m-0 text-heading font-semibold tabular-nums text-accent-strong">
          {line.need}{" "}
          <span className="text-meta font-normal text-text-muted">
            of {line.quantity}
          </span>
        </p>
        <p className="m-0 text-meta text-text-muted wrap-anywhere">
          {countedText(line, deckName)}
        </p>
        {pendingNote && (
          <p className="m-0 text-meta text-text-muted wrap-anywhere">
            {pendingNote}
          </p>
        )}
      </div>
      <LineCost deckId={deckId} editionId={line.edition_id} />
      {children}
    </li>
  );
}

/** The combined total: each card once, its need and the Decks that need it. */
function CombinedTotal({
  rows,
  toGet,
  phone,
  deckName,
}: {
  rows: CombinedRow[];
  toGet: string;
  phone: boolean;
  deckName: (id: string) => string;
}) {
  const idBase = useId();
  const costSuffix = useTotalCostSuffix();
  const list =
    rows.length === 0 ? (
      <p className="m-0 text-body text-text-muted">
        Every Deck can be built from your Collection.
      </p>
    ) : (
      <ul aria-label="Cards to get" className="m-0 flex list-none flex-col p-0">
        {rows.map((row) => (
          <li
            key={row.edition_id}
            className="grid grid-cols-[52px_minmax(0,1fr)] items-start gap-3 border-b border-border py-2 last:border-b-0"
          >
            <CopyArt name={row.name} imageUrl={row.image_url} />
            <div className="flex min-w-0 flex-col">
              <span className="text-body font-semibold tabular-nums">
                {row.need}
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-body wrap-anywhere">{row.name}</span>
                <span className="text-meta text-text-muted wrap-anywhere">
                  {editionText(row)}
                </span>
                <span className="text-meta text-text-muted wrap-anywhere">
                  {row.decks
                    .map((deck) => `${deckName(deck.deck_id)} ${deck.need}`)
                    .join(" · ")}
                </span>
              </span>
              <RowCost editionId={row.edition_id} />
            </div>
          </li>
        ))}
      </ul>
    );
  const title = `Combined total · ${cards(toGet)}${costSuffix}`;
  if (phone)
    return (
      <details className="col-start-1 row-start-1 rounded-panel border border-border bg-surface">
        <summary className="flex min-h-tap cursor-pointer items-center px-4 text-body font-semibold">
          {title}
        </summary>
        <div className="border-t border-border px-4 pb-2">{list}</div>
      </details>
    );
  return (
    <aside
      aria-labelledby={`${idBase}-total`}
      className="col-start-2 row-start-1 sticky top-[calc(var(--space-4)+var(--layout-sticky-top))] flex flex-col gap-2 rounded-panel border border-border bg-surface p-4"
    >
      <h3 id={`${idBase}-total`} className="m-0 text-body font-semibold">
        {title}
      </h3>
      {list}
    </aside>
  );
}
