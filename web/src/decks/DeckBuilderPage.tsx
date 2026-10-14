import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ChevronLeft } from "lucide-react";
import {
  DeckError,
  getDeck,
  setTargetFormat,
  type DeckDetail,
} from "../decks_generated";
import { PageHeader } from "../shell/PageHeader";
import { Button } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { Segmented, segmentId } from "../ui/Segmented";
import { MOBILE_QUERY, useMediaQuery } from "../workspace/media";
import { CompetitionNotice, SurplusGroup } from "./Surplus";
import { usePutAway } from "./usePutAway";
import { CopySheet } from "./CopySheet";
import { DeckCostLine } from "./DeckCostLine";
import { DeckListBody, type OpenSheet } from "./DeckListViews";
import { deckListModel, type DeckView } from "./deckListModel";
import { GatherDialog } from "./GatherDialog";
import { FormatResultsDialog } from "./FormatResultsDialog";
import { useDeckActions } from "./useDeckActions";
import { flaggedLines, resultFor, type TargetFormat } from "./targetFormat";
import { TargetFormatControl } from "./TargetFormatControl";
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
 * Header row 2 holds the Target Format control (#178): ▾ changes the Deck's Target Format through its Deck List
 * command, and the result opens the results dialog. A card-level issue in that result highlights its lines.
 *
 * The page header holds Export, Publish and Delete, and row 1 Buy missing after Gather N (#181, useDeckActions).
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
  // The Pick List dialog: open with the copy sheet's card (edition), or with none from Gather N.
  const [gather, setGather] = useState<{ edition: string | null } | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const gatherOpener = useRef<HTMLElement | null>(null);
  const [resultsOpen, setResultsOpen] = useState(false);
  // The Target Format a change in flight asks for, and the last failed attempt, whose key a retry reuses.
  const [changing, setChanging] = useState<TargetFormat | null>(null);
  const failedChange = useRef<{
    target: TargetFormat;
    revision: number;
    key: string;
  } | null>(null);
  const resultButton = useRef<HTMLButtonElement | null>(null);
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

  /** Change the Target Format through its Deck List command (revision-checked, idempotent), one at a time. */
  async function changeTarget(target: TargetFormat) {
    if (load.kind !== "ready" || changing) return;
    const current = load.detail;
    if (target === current.target_format) return;
    const revision = current.deck_list.revision;
    const retry = failedChange.current;
    const key =
      retry && retry.target === target && retry.revision === revision
        ? retry.key
        : crypto.randomUUID();
    failedChange.current = null;
    setChanging(target);
    setNotice("");
    reads.current++; // A Deck read already in flight must not overwrite the command's answer.
    try {
      const result = await setTargetFormat(deckId, {
        target_format: target,
        revision,
        idempotency_key: key,
      });
      setLoad((previous) =>
        previous.kind === "ready"
          ? {
              kind: "ready",
              detail: {
                ...previous.detail,
                deck_list: result.deck_list,
                target_format: result.target_format,
                format_checks:
                  result.format_checks ?? previous.detail.format_checks,
              },
            }
          : previous
      );
    } catch (cause) {
      if (cause instanceof DeckError && cause.status === 409) {
        // Re-read first: a successful read clears the notice.
        await read();
        setNotice(
          "This Deck changed somewhere else, so its Target Format wasn't changed. It's up to date now: try again."
        );
      } else if (cause instanceof DeckError && cause.status === 404) {
        setLoad({ kind: "missing" });
      } else {
        failedChange.current = { target, revision, key };
        setNotice(
          "The Target Format couldn't be changed. Check your connection and try again."
        );
      }
    } finally {
      setChanging(null);
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
  // Put away for the surplus group (#180): its dialog and Undo toast outlive the phone's Deck and Library tabs.
  const putAway = usePutAway({
    deckId,
    deckName: detail?.deck.name ?? "",
    surplus: detail?.surplus,
    onChanged: () => void read(),
  });
  const model = useMemo(
    () => (detail ? deckListModel(detail) : null),
    [detail]
  );
  const gathered = useGatherToast(detail?.deck.name ?? "", () => void read());
  const targetResult = detail
    ? resultFor(detail.format_checks, detail.target_format)
    : null;
  const flagged = useMemo(() => flaggedLines(targetResult), [targetResult]);
  const deckActions = useDeckActions({
    deckId,
    detail,
    result: changing ? null : targetResult,
    target: changing ?? detail?.target_format ?? "standard",
    read: () => void read(),
    onAllDecks,
  });
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
      <CompetitionNotice warnings={detail.competition} lines={model.lines} />
      <h2 id={`${idBase}-deck-list`} className="sr-only">
        Deck List
      </h2>
      {/* Row 1: the count, the cost, Gather N and Buy missing (#181). */}
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
          {deckActions.buyMissing}
        </div>
      </div>
      {/* Row 2: the Target Format control (#178), then the view switch. */}
      <div className="flex flex-wrap items-center gap-2">
        <TargetFormatControl
          value={changing ?? detail.target_format}
          result={changing ? null : targetResult}
          busy={changing !== null}
          onChange={(target) => void changeTarget(target)}
          onOpenResult={() => setResultsOpen(true)}
          resultRef={resultButton}
        />
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
      <DeckListBody
        view={view}
        groups={model.groups}
        onOpen={open}
        flagged={flagged}
      />
      {view !== "list" && model.groups.length > 0 && (
        <p className="m-0 border-t border-border pt-2 text-caption text-text-subtle">
          Solid: in this Deck · Dashed ↻: owned elsewhere · Faded $: not owned
        </p>
      )}
      <SurplusGroup
        rows={detail.surplus}
        view={view}
        onPutAway={putAway.open}
      />
      {putAway.dialog}
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
      {/* #177: the library's format chip starts on detail.target_format (#178). */}
      <p className="m-0 text-body text-text-muted">
        Adding cards from your Collection and the catalog comes in the next
        update.
      </p>
    </aside>
  );

  return (
    <main className="mx-auto box-border flex max-w-7xl flex-col gap-4 px-7 py-6 phone:px-4 phone:py-4">
      {back}
      <PageHeader title={detail.deck.name} actions={deckActions.actions} />
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
      {deckActions.dialogs}
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
      {targetResult && (
        <FormatResultsDialog
          open={resultsOpen}
          onClose={() => setResultsOpen(false)}
          returnFocus={resultButton}
          deckId={deckId}
          targetFormat={detail.target_format}
          today={targetResult}
          disclaimer={detail.format_checks.disclaimer}
          lines={model.lines}
        />
      )}
    </main>
  );
}
