import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ChevronLeft } from "lucide-react";
import { DeckError, getDeck, type DeckDetail } from "../decks_generated";
import { PageHeader } from "../shell/PageHeader";
import { Button } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { Segmented, segmentId } from "../ui/Segmented";
import { MOBILE_QUERY, useMediaQuery } from "../workspace/media";
import { CopySheet } from "./CopySheet";
import { DeckCostLine } from "./DeckCostLine";
import { DeckListBody, type OpenSheet } from "./DeckListViews";
import { deckListModel, type DeckView } from "./deckListModel";
import { GatherDialog } from "./GatherDialog";
import { LegacyDeckTools } from "./LegacyDeckTools";
import { useDeckCost } from "./useDeckCost";
import { useGatherToast } from "./useGatherToast";

type Props = {
  /** The Deck's id, from the address /decks/<id>. */
  deckId: string;
  /** Back to the Decks index (/decks). */
  onAllDecks: () => void;
};

type Load =
  | { kind: "loading" }
  | { kind: "ready"; detail: DeckDetail }
  | { kind: "missing" }
  | { kind: "failed" };

type Pane = "library" | "deck";

const VIEWS = [
  { value: "spread", label: "Spread" },
  { value: "stacked", label: "Stacked" },
  { value: "list", label: "List" },
] as const;

/**
 * The deck builder (#176): opening a Deck on the Decks page shows its Deck List as the main area, with every
 * copy's ownership state and the cost, in Spread, Stacked and List, and a column on the right for the card
 * library (#177). On a phone, Deck and Library tabs switch between the two, Library first, with the live
 * count on the Deck tab.
 *
 * Row 1's Gather N opens the Pick List dialog (#179), as does the copy sheet's Gather on that card.
 *
 * Seams for later tickets: header row 1 takes Buy missing (#181) after Gather N; row 2
 * takes the Target Format control (#178) before the view switch; the page header takes Export, Publish and
 * Delete (#181), which also retires the old panels at the foot of the page.
 */
export function DeckBuilderPage({ deckId, onAllDecks }: Props) {
  const phone = useMediaQuery(MOBILE_QUERY);
  const idBase = useId();
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [notice, setNotice] = useState("");
  const [view, setView] = useState<DeckView>(() =>
    window.matchMedia(MOBILE_QUERY).matches ? "stacked" : "spread"
  );
  const [pane, setPane] = useState<Pane>("library");
  const [sheet, setSheet] = useState<{
    editionId: string;
    ordinal: number | null;
  } | null>(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  // The Pick List dialog: open with the copy sheet's card (edition), or with none from Gather N.
  const [gather, setGather] = useState<{ edition: string | null } | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const gatherOpener = useRef<HTMLElement | null>(null);
  const reads = useRef(0);

  async function read() {
    const ticket = ++reads.current;
    try {
      const detail = await getDeck(deckId);
      if (ticket !== reads.current) return;
      setLoad({ kind: "ready", detail });
      setNotice("");
    } catch (cause) {
      if (ticket !== reads.current) return;
      if (
        cause instanceof DeckError &&
        (cause.status === 404 || cause.status === 422)
      )
        setLoad({ kind: "missing" });
      else {
        setLoad((previous) =>
          previous.kind === "ready" ? previous : { kind: "failed" }
        );
        setNotice(
          "This Deck couldn't be loaded. Check your connection and try again."
        );
      }
    }
  }

  // A Deck opened from the index starts at the top; the shell keeps the scroll position within one page.
  useLayoutEffect(() => {
    window.scrollTo(0, 0);
    void read();
  }, []);

  const detail = load.kind === "ready" ? load.detail : null;
  const cost = useDeckCost(
    deckId,
    detail?.deck_list.revision ?? null,
    detail?.owner_revision ?? null,
    () => void read()
  );
  const model = useMemo(
    () => (detail ? deckListModel(detail) : null),
    [detail]
  );
  const gathered = useGatherToast(detail?.deck.name ?? "", () => void read());
  const open: OpenSheet = (line, ordinal, element) => {
    opener.current = element;
    setSheet({ editionId: line.line.edition_id, ordinal });
  };
  const sheetLine =
    (sheet &&
      model?.lines.find((line) => line.line.edition_id === sheet.editionId)) ??
    null;
  // A line that left the Deck List (a later read) closes its sheet, so a stale one never reopens.
  useEffect(() => {
    if (sheet && !sheetLine) setSheet(null);
  }, [sheet, sheetLine]);

  const back = (
    <a
      href="/decks"
      onClick={(event) => {
        event.preventDefault();
        onAllDecks();
      }}
      className="inline-flex h-control items-center gap-1 self-start rounded-control px-2 text-control font-medium text-text-muted no-underline hover:bg-surface-raised hover:text-text phone:h-control-phone"
    >
      <Icon icon={ChevronLeft} />
      All Decks
    </a>
  );

  if (!detail || !model)
    return (
      <main className="mx-auto box-border flex max-w-7xl flex-col gap-4 px-7 py-6 phone:px-4 phone:py-4">
        {back}
        {load.kind === "missing" ? (
          <>
            <PageHeader title="Deck not found" />
            <p className="m-0 text-body text-text-muted">
              This Deck doesn't exist, or it was deleted.
            </p>
          </>
        ) : load.kind === "failed" ? (
          <>
            <PageHeader title="Deck unavailable" />
            <p role="status" className="m-0 text-body text-text-muted">
              {notice}
            </p>
            <Button className="self-start" onClick={() => void read()}>
              Retry
            </Button>
          </>
        ) : (
          <p role="status" className="m-0 text-body text-text-muted">
            Loading Deck…
          </p>
        )}
      </main>
    );

  const deckTab = segmentId(idBase, "deck");
  const toGather = model.lines.reduce(
    (total, line) => total + line.elsewhere,
    0n
  );
  const deckList = (
    <section
      aria-labelledby={phone ? deckTab : `${idBase}-deck-list`}
      className="flex min-w-0 flex-col gap-4"
    >
      <h2 id={`${idBase}-deck-list`} className="sr-only">
        Deck List
      </h2>
      {/* Row 1: the count, the cost and Gather N. Buy missing (#181) joins Gather N on the right. */}
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <p className="m-0 tabular-nums">
          <strong className="text-display font-semibold">{model.total}</strong>
          <span className="text-body text-text-muted">/60</span>
          <span className="sr-only"> cards</span>
        </p>
        <DeckCostLine settled={cost} />
        <div className="ml-auto flex flex-wrap items-center gap-2 self-center">
          <Button
            disabled={toGather === 0n}
            onClick={(event) => {
              gatherOpener.current = event.currentTarget;
              setGather({ edition: null });
            }}
          >
            Gather {toGather.toString()}
          </Button>
        </div>
      </div>
      {/* Row 2: the Target Format control (#178) goes before the view switch. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="ml-auto">
          <Segmented
            mode="choice"
            label="Deck List view"
            options={VIEWS}
            value={view}
            onChange={setView}
          />
        </div>
      </div>
      <DeckListBody view={view} groups={model.groups} onOpen={open} />
      {view !== "list" && model.groups.length > 0 && (
        <p className="m-0 border-t border-border pt-2 text-caption text-text-subtle">
          Solid: in this Deck · Dashed ↻: owned elsewhere · Faded $: not owned
        </p>
      )}
    </section>
  );
  const library = (
    <aside
      aria-labelledby={`${idBase}-library`}
      className="box-border flex min-w-0 flex-col gap-2 self-start rounded-panel border border-border bg-surface p-4"
    >
      <h2 id={`${idBase}-library`} className="m-0 text-heading font-semibold">
        Library
      </h2>
      <p className="m-0 text-body text-text-muted">
        Adding cards from your Collection and the catalog comes in the next
        update.
      </p>
    </aside>
  );

  return (
    <main className="mx-auto box-border flex max-w-7xl flex-col gap-4 px-7 py-6 phone:px-4 phone:py-4">
      {back}
      <PageHeader title={detail.deck.name} />
      {notice && (
        <p role="status" className="m-0 text-body text-warning">
          {notice}
        </p>
      )}
      {phone ? (
        <>
          <Segmented
            label="Deck builder"
            idBase={idBase}
            panelId={`${idBase}-panel`}
            value={pane}
            onChange={setPane}
            options={[
              { value: "library", label: "Library" },
              { value: "deck", label: "Deck", count: `${model.total}/60` },
            ]}
          />
          <div
            role="tabpanel"
            id={`${idBase}-panel`}
            aria-labelledby={segmentId(idBase, pane)}
            className="min-w-0"
          >
            {pane === "deck" ? deckList : library}
          </div>
        </>
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(16rem,22rem)] items-start gap-6 compact:grid-cols-[minmax(0,1fr)_16rem]">
          {deckList}
          {library}
        </div>
      )}
      <details
        className="mt-4 rounded-panel border border-border"
        onToggle={(event) => setToolsOpen(event.currentTarget.open)}
      >
        <summary className="flex min-h-control cursor-pointer items-center px-4 text-body font-semibold phone:min-h-tap">
          Holdings, publishing and exports
        </summary>
        {toolsOpen && (
          <div className="legacy legacy-light">
            <LegacyDeckTools
              detail={detail}
              cost={cost}
              onInventoryChanged={read}
            />
          </div>
        )}
      </details>
      <CopySheet
        line={sheetLine}
        ordinal={sheet?.ordinal ?? null}
        onClose={() => setSheet(null)}
        returnFocus={opener}
        onGather={(edition) => {
          // The sheet closes and the Pick List opens on its card; closing that returns focus to the copy.
          gatherOpener.current = opener.current;
          setSheet(null);
          setGather({ edition });
        }}
      />
      <GatherDialog
        open={gather !== null}
        deckId={deckId}
        lines={model.lines}
        focusEdition={gather?.edition ?? null}
        returnFocus={gatherOpener}
        onClose={() => setGather(null)}
        onConfirmed={(result) => {
          setGather(null);
          void read();
          void gathered(result);
        }}
        onChanged={() => void read()}
      />
    </main>
  );
}
