import {
  useEffect,
  useId,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { ChevronRight } from "lucide-react";
import { COUNTING_OPTIONS } from "../settings/wantListCounting";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { Icon } from "../ui/Icon";
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

type Props = {
  /** Opens a Deck in the deck builder (/decks/<id>). */
  onOpenDeck: (id: string) => void;
  /** Goes to another address in the app: Settings, or the scoped Want List's own address (replaced, not pushed). */
  onNavigate: (to: string, options?: { replace?: boolean }) => void;
};

type Load =
  { kind: "loading" } | { kind: "ready"; list: WantList } | { kind: "failed" };

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

  if (list.decks.length === 0)
    return (
      <p className="m-0 text-body text-text-muted">
        No Decks yet. Create one on My Decks, and the Want List shows what it
        still needs.
      </p>
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
        className="flex flex-wrap items-center gap-1"
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
            />
          ))}
        </div>
      </div>
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
}: {
  section: WantListSection;
  deckName: (id: string) => string;
  onOpenDeck: (id: string) => void;
  swap: WantListSwap;
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
        <ul
          aria-label={`What ${section.name} needs`}
          className="m-0 list-none border-t border-border p-0"
        >
          {section.lines.map((line) => (
            <NeededLine
              key={line.edition_id}
              deckId={section.deck_id}
              line={line}
              deckName={deckName}
            >
              <SwapHint section={section} line={line} swap={swap} />
            </NeededLine>
          ))}
        </ul>
      )}
    </section>
  );
}

function NeededLine({
  deckId,
  line,
  deckName,
  children,
}: {
  deckId: string;
  line: WantListLine;
  deckName: (id: string) => string;
  /** The line's Swap hint (#211), under its card and counts. */
  children?: ReactNode;
}) {
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-1 border-b border-border px-4 py-3 last:border-b-0 phone:grid-cols-1">
      <div className="min-w-0">
        <p className="m-0 text-body font-medium wrap-anywhere">{line.name}</p>
        <p className="m-0 text-meta text-text-muted wrap-anywhere">
          {editionText(line)}
        </p>
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
            className="flex items-baseline gap-3 border-b border-border py-2 last:border-b-0"
          >
            <span className="w-6 shrink-0 text-right text-body font-semibold tabular-nums">
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
