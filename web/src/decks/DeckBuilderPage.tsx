import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ChevronLeft } from "lucide-react";
import type { BrowseEdition } from "../catalog_browse_generated";
import {
  DeckError,
  getDeck,
  setTargetFormat,
  type DeckDetail,
  type DeckListCommandResult,
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
import { useDeckCover } from "./useDeckCover";
import { useDeckRename } from "./DeckRename";
import { DeckListBody, type OpenSheet } from "./DeckListViews";
import { deckListModel, type DeckView } from "./deckListModel";
import { GatherDialog } from "./GatherDialog";
import { FormatResultsDialog } from "./FormatResultsDialog";
import { useDeckActions } from "./useDeckActions";
import { flaggedLines, resultFor, type TargetFormat } from "./targetFormat";
import { TargetFormatControl } from "./TargetFormatControl";
import { useCardsRevision, useDeckCost } from "./useDeckCost";
import { useGatherToast } from "./useGatherToast";
import { variantLabel } from "../ui/variantLabel";
import { DeckLibrary } from "./DeckLibrary";
import { editionText, type DeckLine } from "./deckListModel";
import { DeckDragBadge, dropLook, useDeckDrag } from "./useDeckDrag";
import { useDeckListEdits } from "./useDeckListEdits";
import { useDeckListChanged } from "./deckListChanged";

type Props = {
  /** The Deck's id, from the address /decks/<id>. */
  deckId: string;
  /** Back to the Decks index (/decks). */
  onAllDecks: () => void;
  /** Replace list… (/decks/<id>/replace, #215). */
  onReplaceList: () => void;
  /** Opens the Want List scoped to this Deck. */
  onWantList: () => void;
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
 * copy's ownership state and the cost, in Spread, Stacked and List, and the card library in a column on the right
 * that scrolls on its own (#177). On a phone, Deck and Library tabs switch between the two, Library first, with the
 * live count on the Deck tab; both stay mounted, so the library keeps its search and results.
 *
 * Editing (#177): dragging a library tile onto the Deck List adds a copy, and the card popup's ±1 does too; a copy's
 * sheet has ±1 and Swap this copy for; dragging a copy onto the library, or Delete or Backspace on it, takes it off.
 * Every edit goes through the batch Deck List command, one at a time (useDeckListEdits), with an Undo toast.
 *
 * Row 1's Gather N opens the Pick List dialog (#179), as does the copy sheet's Gather on that card.
 *
 * Header row 2 holds the Target Format control (#178): its menu changes the Deck's Target Format through its Deck List
 * command, and the result opens the results dialog. A card-level issue in that result highlights its lines.
 *
 * The title has Rename (#291), which swaps it for a field. A copy's sheet has Set as cover (#291): the Deck's cover
 * on My Decks, which stays automatic until one is picked.
 *
 * The page header holds Replace list… (#215), Export, Publish and Delete, and row 1 Buy missing after Gather N (#181,
 * useDeckActions). A Replace's Undo runs from a toast outside the builder and announces the change; the builder reads
 * again (deckListChanged).
 */
export function DeckBuilderPage({
  deckId,
  onAllDecks,
  onReplaceList,
  onWantList,
}: Props) {
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
  // The Deck List revision a Target Format change produced: the cost isn't asked for again at it.
  const formatOnlyRevision = useRef<number | null>(null);
  const resultButton = useRef<HTMLButtonElement | null>(null);
  const reads = useRef(0);
  const readsInFlight = useRef(0);
  // The newest Deck List revision shown, from a read or an edit's answer (#177): a read that left before an edit
  // landed is behind it and is dropped (the edit queue reads again once it drains).
  const shownRevision = useRef(0);
  // After an edit takes a copy off from its control or its sheet: the Editions whose controls should take focus if
  // the control that had it left the page (#177).
  const refocus = useRef<string[] | null>(null);
  const deckListRef = useRef<HTMLElement>(null);
  const [sheetSince, setSheetSince] = useState(0);

  async function read() {
    await readDeck();
  }

  /** Reads the Deck and shows it, unless a newer read or a newer edit's answer came first; gives what it showed. */
  async function readDeck(): Promise<DeckDetail | null> {
    const ticket = ++reads.current;
    readsInFlight.current++;
    try {
      const detail = await getDeck(deckId);
      if (ticket !== reads.current) return null;
      if (detail.deck_list.revision < shownRevision.current) return null;
      shownRevision.current = detail.deck_list.revision;
      setLoad({ kind: "ready", detail });
      setNotice("");
      return detail;
    } catch (cause) {
      if (ticket !== reads.current) return null;
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
      return null;
    } finally {
      readsInFlight.current--;
    }
  }

  /** Before a cover or rename command: drop Deck reads already on their way (they'd show the old name or cover), and
   * give back the call that re-reads once the command has landed if one was dropped. */
  function beginCommand(): () => void {
    const dropped = readsInFlight.current > 0;
    reads.current++;
    return () => {
      if (dropped) void read();
    };
  }

  /** An edit's answer (#177): its Deck List, Target Format and result show at once; the read that follows once the
   * edits drain brings the ownership, checks and surplus up to date. */
  function applyResult(result: DeckListCommandResult) {
    shownRevision.current = Math.max(
      shownRevision.current,
      result.deck_list.revision
    );
    setLoad((previous) =>
      previous.kind === "ready" &&
      result.deck_list.revision >= previous.detail.deck_list.revision
        ? {
            kind: "ready",
            detail: {
              ...previous.detail,
              deck_list: result.deck_list,
              target_format: result.target_format,
              format_checks:
                result.format_checks ?? previous.detail.format_checks,
              // A cover whose line left the Deck List is cleared with it, as the server does.
              cover_edition_id: result.deck_list.lines.some(
                (line) =>
                  line.edition_id === (previous.detail.cover_edition_id ?? null)
              )
                ? (previous.detail.cover_edition_id ?? null)
                : null,
            },
          }
        : previous
    );
  }

  /** Change the Target Format through its Deck List command (revision-checked, idempotent), one at a time. */
  async function changeTarget(target: TargetFormat) {
    // Not while Deck List edits are on their way: they move the revision this command is checked against.
    if (load.kind !== "ready" || changing || edits.busy) return;
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
      formatOnlyRevision.current = result.deck_list.revision;
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
  useDeckListChanged(deckId, () => void read());

  const detail = load.kind === "ready" ? load.detail : null;
  const edits = useDeckListEdits({
    deckId,
    deckList: detail?.deck_list ?? null,
    onResult: applyResult,
    onSettled: () => void read(),
    reread: async () => (await readDeck())?.deck_list ?? null,
    onMissing: () => setLoad({ kind: "missing" }),
  });
  const coverId = detail?.cover_edition_id ?? null;
  const cover = useDeckCover({
    deckId,
    coverId,
    beginCommand,
    onCover: (id) =>
      setLoad((previous) =>
        previous.kind === "ready"
          ? {
              kind: "ready",
              detail: { ...previous.detail, cover_edition_id: id },
            }
          : previous
      ),
    reread: readDeck,
    onMissing: () => setLoad({ kind: "missing" }),
  });
  const rename = useDeckRename({
    deckId,
    deck: detail?.deck ?? null,
    beginCommand,
    onRenamed: (deck) =>
      setLoad((previous) =>
        previous.kind === "ready"
          ? { kind: "ready", detail: { ...previous.detail, deck } }
          : previous
      ),
    reread: readDeck,
    onMissing: () => setLoad({ kind: "missing" }),
  });
  /** One Edition, `delta` copies on or off the Deck List, as one edit. */
  const step = (editionId: string, name: string, delta: bigint) =>
    edits.edit({
      deltas: new Map([[editionId, delta]]),
      names: new Map([[editionId, name]]),
      message:
        delta > 0n ? `Added ${delta} ${name}.` : `Removed ${-delta} ${name}.`,
    });
  /** Swap one copy of a line for another Edition of its Card Identity: one batch, so one Undo puts it back. */
  const swap = (line: DeckLine, row: BrowseEdition) => {
    const from = line.line.edition_id;
    refocus.current = [row.edition_id, from];
    setSheet(null);
    edits.edit({
      deltas: new Map([
        [from, -1n],
        [row.edition_id, 1n],
      ]),
      names: new Map([
        [from, line.line.name],
        [row.edition_id, row.name],
      ]),
      message: `Swapped a copy of ${line.line.name} (${editionText(line)}) for ${row.name} (${row.set_name} · ${row.collector_number} · ${variantLabel(row.descriptor)}).`,
    });
  };
  const drag = useDeckDrag({
    enabled: !phone,
    onDrop: (payload) =>
      step(
        payload.editionId,
        payload.name,
        payload.from === "library" ? 1n : -1n
      ),
  });
  // A copy taken off from its control (Delete, or −1 in its sheet) can take that control with it: once the edits
  // have landed, focus moves to the line's last control, or else to the toast's Undo.
  useEffect(() => {
    const wanted = refocus.current;
    // busyNow, not busy: React can run the previous commit's effect late, after the keypress that set `wanted` has
    // queued its edit; that render's own busy is stale and would use up `wanted` while the control is still there.
    if (!wanted || edits.busyNow() || sheet) return;
    refocus.current = null;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    for (const id of wanted) {
      const controls = deckListRef.current?.querySelectorAll<HTMLElement>(
        `[data-edition-id="${CSS.escape(id)}"]`
      );
      const last = controls?.[controls.length - 1];
      if (last) {
        last.focus();
        return;
      }
    }
    edits.focusUndo();
  });
  // A Target Format change moves the Deck List revision, not the cards, so it doesn't ask for the cost again.
  const cardsRevision = useCardsRevision(
    detail?.deck_list.revision ?? null,
    formatOnlyRevision.current
  );
  const cost = useDeckCost(
    deckId,
    detail?.deck_list.revision ?? null,
    detail?.owner_revision ?? null,
    () => void read(),
    detail?.settings_revision ?? null,
    cardsRevision
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
    onReplaceList,
  });
  const open: OpenSheet = (line, ordinal, element) => {
    opener.current = element;
    cover.reset();
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
      <main className="mx-auto box-border flex w-full min-w-0 max-w-7xl flex-col gap-4 px-7 py-6 phone:gap-2 phone:px-4 phone:py-2">
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
      ref={deckListRef}
      aria-labelledby={phone ? deckTab : `${idBase}-deck-list`}
      data-deck-drop="deck"
      className={`flex min-w-0 flex-col gap-4 rounded-panel${dropLook(drag.dragging, "deck")}`}
    >
      <CompetitionNotice warnings={detail.competition} lines={model.lines} />
      <h2 id={`${idBase}-deck-list`} className="sr-only">
        Deck List
      </h2>
      <div className="flex flex-col gap-3 rounded-panel border border-border bg-surface p-3 phone:gap-2">
        {/* Row 1: the count, the cost, Gather N and Buy missing (#181). */}
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <p className="m-0 tabular-nums">
            <strong className="text-display font-semibold">
              {model.total}
            </strong>
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
            <Button onClick={onWantList}>Want List</Button>
          </div>
        </div>
        {/* Row 2: the Target Format control (#178), then the view switch. */}
        <div className="flex flex-wrap items-center gap-2">
          <TargetFormatControl
            value={changing ?? detail.target_format}
            result={changing ? null : targetResult}
            busy={changing !== null || edits.busy}
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
      </div>
      <DeckListBody
        view={view}
        groups={model.groups}
        onOpen={(line, ordinal, element) => {
          setSheetSince(edits.feedback?.id ?? 0);
          open(line, ordinal, element);
        }}
        flagged={flagged}
        editing={{
          onRemove: (line) => {
            refocus.current = [line.line.edition_id];
            step(line.line.edition_id, line.line.name, -1n);
          },
          onStep: (line, delta) => {
            if (delta < 0n) refocus.current = [line.line.edition_id];
            step(line.line.edition_id, line.line.name, delta);
          },
          onDragStart: (line, event) =>
            drag.start(
              {
                from: "deck",
                editionId: line.line.edition_id,
                name: line.line.name,
              },
              event
            ),
        }}
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
  // The library's format chip starts on the Deck's Target Format (#178).
  const library = (
    <DeckLibrary
      deckId={deckId}
      headingId={`${idBase}-library`}
      targetFormat={detail.target_format}
      ownScroll={!phone}
      quantityOf={edits.quantityOf}
      onChange={(row, delta) => step(row.edition_id, row.name, delta)}
      feedback={edits.feedback}
      onDragStart={drag.start}
      dropClass={dropLook(drag.dragging, "library")}
    />
  );

  return (
    <main className="mx-auto box-border flex w-full min-w-0 max-w-7xl flex-col gap-4 px-7 py-6 phone:gap-2 phone:px-4 phone:py-2">
      {back}
      <div className="[&>div]:mb-0 phone:[&>div]:gap-2">
        <PageHeader
          title={detail.deck.name}
          actions={deckActions.actions}
          titleAction={rename.action}
          titleEditor={rename.editor}
        />
      </div>
      {rename.status}
      {notice && (
        <p role="status" className="m-0 text-body text-warning">
          {notice}
        </p>
      )}
      {edits.notice && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 text-body text-warning"
        >
          <p className="m-0">{edits.notice.text}</p>
          {edits.notice.retry && (
            <Button onClick={edits.notice.retry}>Try again</Button>
          )}
        </div>
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
            <div hidden={pane !== "deck"}>{deckList}</div>
            <div hidden={pane !== "library"}>{library}</div>
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
        editing={
          sheetLine
            ? {
                deckId,
                quantity: edits.quantityOf(sheetLine.line.edition_id),
                onChange: (delta) => {
                  if (delta < 0n) refocus.current = [sheetLine.line.edition_id];
                  step(sheetLine.line.edition_id, sheetLine.line.name, delta);
                },
                onSwap: (row) => swap(sheetLine, row),
                feedback: edits.feedback,
                since: sheetSince,
              }
            : undefined
        }
        cover={
          sheetLine
            ? {
                isCover: sheetLine.line.edition_id === coverId,
                busy: cover.busy,
                message: cover.messageFor(sheetLine.line.edition_id),
                onToggle: () => void cover.toggle(sheetLine.line.edition_id),
              }
            : undefined
        }
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
      <DeckDragBadge dragging={drag.dragging} />
    </main>
  );
}
