import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { COLLECTION_IMPORT_PATH } from "../../collectionImport/route";
import { workspaceHref } from "../../workspace/workspaceLink";
import { CLOSE_PATH } from "../entry/paths";
import type { LockResult, TrayRow, TrayStore } from "../tray/store";
import type { LockVia } from "../worker/messages";
import { CameraStage, Shutter, TopBar } from "./CameraStage";
import { CannotStart } from "./CannotStart";
import { CardSearch, type SearchPick } from "./CardSearch";
import { confirmEffect } from "./confirmFlow";
import {
  CHANGE_SEARCH_TITLE,
  DESTINATION_NOTE,
  PAUSED_STRIP,
  PAUSED_STRIP_LABEL,
  HINT_EDITION_LIMIT,
  SEARCH_MISS,
  SEARCH_TITLE,
  TRAY_FULL,
} from "./copy";
import { GettingReady } from "./GettingReady";
import { gateHint, outcomeHint } from "./hints";
import { leaveToast } from "./landing";
import { answerSafely, capReaction, reactToLock } from "./lockOutcome";
import { readCardFaces, type CardFace } from "./offlineCards";
import { rowView, type RowView } from "./rowView";
import { playLockCue, readLockSound, writeLockSound } from "./sound";
import {
  ChoiceSlot,
  onAbsent,
  resetChoices,
  onLock,
  useChoiceOpen,
  type ChoiceHost,
} from "./choices";
import { ClearDialog, DestinationDialog, FullPrompt } from "./TrayDialogs";
import { TrayOpen, type OpenModel } from "./TrayOpen";
import { TrayPeek } from "./TrayPeek";
import type { RowActions } from "./TrayRowItem";
import { useDestinations } from "./useDestinations";
import { useGuideBox } from "./useGuideBox";
import { useScannerSession, type ScannerControls } from "./useScannerSession";
import { copiesIn, useTrayRefresh, useTrayState } from "./useTray";

type SearchState = { mode: "miss" | "add" | "change"; rowId?: string };
const HINT_MS = 5000;
const FLASH_MS = 300;

const noFace = (): CardFace | null => null;

/** The scanner with its tray: the camera and guide, the hint pill, the shutter, the tray peek and the open tray. */
export function ScannerScreen({ store }: { store: TrayStore }) {
  const state = useTrayState(store);
  const destinations = useDestinations();
  const [attempt, setAttempt] = useState(0);
  const video = useRef<HTMLVideoElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const shutterRef = useRef<HTMLButtonElement>(null);
  const reviewRef = useRef<HTMLButtonElement>(null);
  const returnRef = useRef<HTMLElement | null>(null);
  const rowEls = useRef(new Map<string, HTMLElement>());
  const [sheetOpen, setSheetOpen] = useState(
    () => state.tray.pending_save !== null
  );
  const [search, setSearch] = useState<SearchState | null>(null);
  const [searchNotice, setSearchNotice] = useState<string | null>(null);
  const [fullPrompt, setFullPrompt] = useState(false);
  const [dialog, setDialog] = useState<null | "destination" | "clear">(null);
  const [destinationNote, setDestinationNote] = useState<string | null>(null);
  const [hint, setHint] = useState<{ text: string; id: number } | null>(null);
  const [flash, setFlash] = useState(false);
  const [sound, setSound] = useState(readLockSound);
  const [lastId, setLastId] = useState<string | null>(null);
  const [hidden, setHidden] = useState(document.hidden);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [editionsNote, setEditionsNote] = useState(false);
  const [searchRows, setSearchRows] = useState<ReadonlySet<string>>(new Set());
  const [faces, setFaces] = useState<(id: string) => CardFace | null>(
    () => noFace
  );
  const controls = useRef<ScannerControls | null>(null);
  const hintId = useRef(0);

  const showHint = useCallback((text: string) => {
    setHint({ text, id: ++hintId.current });
  }, []);
  useEffect(() => {
    if (!hint) return;
    const timer = window.setTimeout(() => setHint(null), HINT_MS);
    return () => window.clearTimeout(timer);
  }, [hint]);
  useEffect(() => {
    if (!flash) return;
    const timer = window.setTimeout(() => setFlash(false), FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [flash]);
  useEffect(() => {
    const onVisibility = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  const openSheet = useCallback(() => setSheetOpen(true), []);
  // Answers a lock's result: the worker's `lockOutcome`, then the cue, hint or prompt it calls for.
  const settleLock = useCallback(
    (
      lockId: number,
      result: LockResult,
      via: LockVia,
      to: ScannerControls | null
    ) => {
      const outcome = reactToLock(result, via);
      to?.answer(lockId, outcome.message.added, outcome.message.reason);
      const reaction = outcome.reaction;
      if (reaction.kind === "added") {
        if (result.row) setLastId(result.row.id);
        setFlash(true);
        playLockCue(readLockSound());
      } else if (reaction.kind === "hint") showHint(outcomeHint(reaction.hint));
      else if (reaction.kind === "full-prompt") setFullPrompt(true);
      else if (reaction.kind === "open-tray") openSheet();
      else if (reaction.kind === "search") {
        returnRef.current = null;
        setSearch({ mode: "miss" });
      }
    },
    [showHint, openSheet]
  );
  const handleLock = useCallback(
    (lock: {
      lockId: number;
      printingIds: string[];
      lookalikes: string[];
      via: LockVia;
    }) => {
      // The lock is answered through the session it came from, even if Try again has replaced it since.
      const from = controls.current;
      let via = lock.via;
      const host: ChoiceHost = {
        resolve: (ids) => store.lookupPrintings(ids),
        add: async (printingId, editionId, candidates) => {
          const r = await answerSafely(
            () => store.applyChoice({ printingId, editionId, candidates }),
            lock.via
          );
          via = r.via;
          return r.result;
        },
        answer: (id, added, reason) => from?.answer(id, added, reason),
        settle: (id, result) => settleLock(id, result, via, from),
        openSearch: () => {
          returnRef.current = shutterRef.current;
          setSearch({ mode: "add" });
        },
      };
      onLock(lock, host);
    },
    [store, settleLock]
  );
  const session = useScannerSession(
    video,
    {
      onLock: handleLock,
      onAbsent: onAbsent,
      onMiss: () =>
        setSearch((current) => {
          if (current) return current;
          returnRef.current = shutterRef.current;
          return { mode: "miss" };
        }),
      onAssets: (assets) =>
        void readCardFaces(assets.cards).then((f) => setFaces(() => f)),
    },
    attempt
  );
  controls.current = session;
  const phase = session.phase;
  // A prompt or lookup belongs to the session that made it: end it when the session restarts, cannot start or goes.
  useEffect(() => resetChoices, [attempt]);
  const cannotStart = phase.kind === "cannot-start";
  useEffect(() => {
    if (cannotStart) resetChoices();
  }, [cannotStart]);
  const running = phase.kind === "running";
  const suggesting = useChoiceOpen();

  const paused =
    sheetOpen || search !== null || fullPrompt || dialog !== null || hidden;
  useEffect(() => session.setPaused(paused), [paused]); // eslint-disable-line react-hooks/exhaustive-deps
  useTrayRefresh(store, sheetOpen);
  const reloadDestinations = destinations.reload;
  const destinationsFailed = destinations.state === "failed";
  useEffect(() => {
    if (sheetOpen && destinationsFailed) reloadDestinations();
  }, [sheetOpen]); // eslint-disable-line react-hooks/exhaustive-deps
  const guide = useGuideBox(stage, video, phase.kind);

  // Focus goes into the tray when it opens and back to Review when it closes.
  const wasOpen = useRef(sheetOpen);
  useEffect(() => {
    if (sheetOpen && !wasOpen.current) keepRef.current?.focus();
    if (!sheetOpen && wasOpen.current) reviewRef.current?.focus();
    wasOpen.current = sheetOpen;
  }, [sheetOpen]);

  const rows = state.tray.rows;
  const total = copiesIn(state);
  const frozen = state.tray.pending_save !== null;
  const needs = rows.filter((r) => r.needs_pick).length;
  const destinationId = state.tray.location_id ?? destinations.unsortedId;
  const where = destinationId ? destinations.path(destinationId) : null;
  const view = useCallback(
    (row: TrayRow): RowView =>
      rowView(
        row,
        state.printings.get(row.printing_id),
        faces(row.printing_id),
        {
          offline: state.offline,
          searchRow: searchRows.has(row.id),
        }
      ),
    [state.printings, state.offline, faces, searchRows]
  );

  const refuse = (verdict: Parameters<typeof capReaction>[0]) => {
    const reaction = capReaction(verdict);
    if (reaction.kind === "hint") setMessage(HINT_EDITION_LIMIT);
    else if (reaction.kind === "full-prompt") setMessage(TRAY_FULL);
  };
  const actions: RowActions = useMemo(
    () => ({
      setEdition: (rowId, editionId) => {
        setLastId(rowId);
        setMessage(null);
        void store
          .setEdition(rowId, editionId)
          .then((r) => r !== "ok" && refuse(r as never));
      },
      setCount: (rowId, count) => {
        setLastId(rowId);
        setMessage(null);
        void store
          .setCount(rowId, count)
          .then((r) => r !== "ok" && refuse(r as never));
      },
      remove: (rowId) => {
        const list = store.getState().tray.rows;
        const at = list.findIndex((r) => r.id === rowId);
        const next = list[at + 1] ?? list[at - 1];
        void store.removeRow(rowId).then(() =>
          // The bin's row is gone: focus goes to its neighbour, or to Keep scanning when the tray is empty.
          requestAnimationFrame(() =>
            ((next && rowEls.current.get(next.id)) || keepRef.current)?.focus()
          )
        );
      },
      change: (rowId, opener) => {
        returnRef.current = opener;
        setSearchNotice(null);
        setSearch({ mode: "change", rowId });
      },
    }),
    [store]
  );

  const picking = useRef(false);
  async function pickFromSearch(pick: SearchPick) {
    if (!search || picking.current) return;
    picking.current = true;
    try {
      await settlePick(pick, search);
    } finally {
      picking.current = false;
    }
  }
  async function settlePick(pick: SearchPick, search: SearchState) {
    const result = await store.applySearchPick({
      ...pick,
      replaceRowId: search.mode === "change" ? search.rowId : undefined,
    });
    if (result === "ok") {
      if (search.rowId) {
        setLastId(search.rowId);
        setSearchRows((current) => {
          const next = new Set(current);
          next.delete(search.rowId!);
          return next;
        });
      }
      setSearchNotice(null);
      setSearch(null);
      void store.refreshStale();
      return;
    }
    const reaction = capReaction(result as never);
    setSearchNotice(
      reaction.kind === "hint"
        ? HINT_EDITION_LIMIT
        : reaction.kind === "full-prompt"
          ? TRAY_FULL
          : null
    );
  }

  async function confirm() {
    if (!destinationId || saving) return;
    setSaving(true);
    setMessage(null);
    setEditionsNote(false);
    const label = where ?? "Collection";
    const result = await store.confirm(destinationId);
    const effect = confirmEffect(result, label);
    if (effect.kind === "land") {
      leaveToast(effect.toast);
      location.assign(workspaceHref(effect.locationId));
      return;
    }
    setSaving(false);
    if (effect.kind === "reopen-picker") {
      setDestinationNote(DESTINATION_NOTE);
      destinations.reload();
      setDialog("destination");
    } else if (effect.kind === "mark-rows") {
      setEditionsNote(true);
      setSearchRows(new Set(effect.searchRowIds));
      void store.refreshStale();
    } else if (effect.kind === "message") setMessage(effect.text);
  }

  const openModel: OpenModel | null = !sheetOpen
    ? null
    : {
        rows: rows.map((row) => ({ row, view: view(row) })),
        total,
        needs,
        frozen,
        saving,
        offline: state.offline,
        where,
        canConfirm:
          total > 0 &&
          needs === 0 &&
          !state.offline &&
          !frozen &&
          destinationId !== null,
        staleSave: state.staleSaveNote,
        editionsNote,
        message,
        destinationsFailed,
      };
  const lastRow = rows.find((r) => r.id === lastId) ?? rows[0] ?? null;
  const showPeek = running || rows.length > 0;

  return (
    <div
      className="absolute inset-0 flex flex-col overflow-hidden bg-bg font-sans text-text scheme-dark"
      onKeyDown={(event) => {
        if (event.key === "Escape" && sheetOpen && !event.defaultPrevented)
          setSheetOpen(false);
      }}
    >
      <div
        // The camera side is out of reach while the tray is open: focus stays in the tray.
        inert={sheetOpen}
        className="flex min-h-0 grow flex-col"
      >
        <TopBar
          sound={sound}
          onSound={() => {
            const next = !sound;
            setSound(next);
            writeLockSound(next);
            if (next) playLockCue(true);
          }}
          onClose={() => location.assign(CLOSE_PATH)}
        />
        <CameraStage
          stageRef={stage}
          videoRef={video}
          guide={guide}
          flash={flash}
          hint={hint?.text ?? (session.gate ? gateHint(session.gate) : null)}
        >
          {phase.kind === "loading" && (
            <GettingReady progress={phase.progress} />
          )}
          {phase.kind === "cannot-start" && (
            <CannotStart
              cause={phase.cause}
              trayCopies={total}
              onSearch={() => {
                returnRef.current = null;
                setSearch({ mode: "add" });
              }}
              onImport={() => location.assign(COLLECTION_IMPORT_PATH)}
              onTryAgain={() => setAttempt((n) => n + 1)}
              onReviewTray={openSheet}
            />
          )}
          <ChoiceSlot returnTo={shutterRef} />
        </CameraStage>
        {running && (
          <Shutter
            onPress={() => session.shutter()}
            disabled={suggesting}
            buttonRef={shutterRef}
          />
        )}
        {showPeek && (
          <TrayPeek
            total={total}
            last={
              lastRow
                ? {
                    key: `${lastRow.id}:${lastRow.count}`,
                    view: view(lastRow),
                    count: lastRow.count,
                  }
                : null
            }
            reviewRef={reviewRef}
            onReview={openSheet}
          />
        )}
      </div>
      {sheetOpen && openModel && (
        <>
          <button
            type="button"
            aria-label={PAUSED_STRIP_LABEL}
            onClick={() => setSheetOpen(false)}
            className="absolute inset-x-0 top-0 z-10 box-border h-[15dvh] cursor-pointer border-0 bg-transparent p-0 font-sans text-meta text-text-muted"
          >
            {PAUSED_STRIP}
          </button>
          <TrayOpen
            model={openModel}
            actions={actions}
            keepRef={keepRef}
            onKeep={() => setSheetOpen(false)}
            onDestination={() => {
              setDestinationNote(null);
              setDialog("destination");
            }}
            onClear={() => setDialog("clear")}
            onConfirm={() => void confirm()}
            onOpenDestination={() =>
              destinationId && location.assign(workspaceHref(destinationId))
            }
            onDismissStaleSave={store.dismissStaleSaveNote}
            rowRef={(id, element) => {
              if (element) rowEls.current.set(id, element);
              else rowEls.current.delete(id);
            }}
          />
        </>
      )}
      {search && (
        <CardSearch
          title={search.mode === "change" ? CHANGE_SEARCH_TITLE : SEARCH_TITLE}
          intro={search.mode === "miss" ? SEARCH_MISS : undefined}
          notice={searchNotice}
          onPick={(pick) => void pickFromSearch(pick)}
          onClose={() => {
            setSearch(null);
            setSearchNotice(null);
          }}
          returnFocus={returnRef}
        />
      )}
      {dialog === "destination" && (
        <DestinationDialog
          leaves={destinations.leaves}
          value={destinationId}
          note={destinationNote}
          onChoose={(id) => {
            void store.setLocation(id === destinations.unsortedId ? null : id);
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "clear" && (
        <ClearDialog
          copies={total}
          onClear={() => {
            setDialog(null);
            void store
              .clear()
              .then(() =>
                requestAnimationFrame(() => keepRef.current?.focus())
              );
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {fullPrompt && (
        <FullPrompt
          onReview={() => {
            setFullPrompt(false);
            openSheet();
          }}
          onClose={() => setFullPrompt(false)}
        />
      )}
    </div>
  );
}
