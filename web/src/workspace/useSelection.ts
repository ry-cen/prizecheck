import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GalleryHolding, GalleryStatus, TileRef } from "./galleryModel";
import {
  addSpans,
  EMPTY_SELECTION,
  isOnlyTile,
  isTileSelected,
  onlyTile,
  reconcileSelection,
  summarizeSelection,
  toggleTile,
  type IndexSpans,
  type Selection,
  type SelectionSummary,
} from "./selectionModel";

/** A tile gesture. `toggle` is Ctrl/Cmd, `range` is Shift. Space is its own gesture. */
export type TileGesture =
  { kind: "click"; toggle: boolean; range: boolean } | { kind: "space" };

/** A marquee drag from empty gallery space. `spans` are the tiles it covers now. */
export type MarqueeEvent = {
  phase: "start" | "move" | "end";
  additive: boolean;
  spans: IndexSpans;
};

/** A copy shown in the inspector or the details sheet. */
export type Inspected = { holding: GalleryHolding; ordinal: number };

type Options = {
  holdings: GalleryHolding[];
  status: GalleryStatus;
  /** selectionScope(query): the selection clears whenever this changes. */
  scope: string;
  /** The mobile layout: a tap opens details unless Select mode is on. */
  mobile: boolean;
};

export type SelectionState = {
  selected: Selection;
  summary: SelectionSummary;
  /** The inspector's card: with a selection, the last clicked selected Holding; otherwise the hovered one. */
  inspected: Inspected | null;
  /** The mobile details sheet's card, or null while it is closed. */
  details: Inspected | null;
  selectMode: boolean;
  setSelectMode: (on: boolean) => void;
  clear: () => void;
  activate: (tile: TileRef, gesture: TileGesture) => void;
  hover: (tile: TileRef | null) => void;
  marquee: (event: MarqueeEvent) => void;
  /** Opens the details sheet for the inspected card (the mobile strip's Details). */
  openDetails: () => void;
  closeDetails: () => void;
};

/** Selection, inspection and Select mode for the workspace gallery (resolution 29).
 * Callbacks are stable, so memoized tiles don't re-render when the selection changes elsewhere. */
export function useSelection({
  holdings,
  status,
  scope,
  mobile,
}: Options): SelectionState {
  const [selected, setSelected] = useState<Selection>(EMPTY_SELECTION);
  // The last clicked Holding that is still selected.
  const [focus, setFocus] = useState<Inspected | null>(null);
  const [hovered, setHovered] = useState<Inspected | null>(null);
  const [details, setDetails] = useState<Inspected | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  // Shift-click ranges start here. A Holding key and ordinal, never a display index, so a sort keeps it valid.
  const anchor = useRef<{ key: string; ordinal: number } | null>(null);
  const marqueeBase = useRef<Selection>(EMPTY_SELECTION);

  const byKey = useMemo(
    () => new Map(holdings.map((holding) => [holding.key, holding])),
    [holdings]
  );
  const latest = useRef({
    selected,
    holdings,
    byKey,
    mobile,
    selectMode,
    focus,
  });
  latest.current = { ...latest.current, holdings, byKey, mobile, selectMode };

  const commit = useCallback((next: Selection, clicked?: Inspected) => {
    const previous = latest.current.focus;
    let nextFocus: Inspected | null = null;
    if (next.size) {
      if (clicked && isTileSelected(next, clicked.holding.key, clicked.ordinal))
        nextFocus = clicked;
      else if (previous && next.has(previous.holding.key)) nextFocus = previous;
      else {
        const last = Array.from(next.values()).pop()!;
        const holding = latest.current.byKey.get(last.key);
        nextFocus = holding ? { holding, ordinal: last.runs[0][0] } : null;
      }
    }
    latest.current.selected = next;
    latest.current.focus = nextFocus;
    setSelected(next);
    setFocus(nextFocus);
  }, []);

  const clear = useCallback(() => {
    anchor.current = null;
    commit(EMPTY_SELECTION);
  }, [commit]);

  const activate = useCallback(
    (tile: TileRef, gesture: TileGesture) => {
      const {
        selected: current,
        mobile: onMobile,
        selectMode: selecting,
      } = latest.current;
      const clicked = { holding: tile.holding, ordinal: tile.ordinal };
      const key = tile.holding.key;
      if (onMobile && !selecting) {
        setDetails(clicked);
        return;
      }
      if (gesture.kind === "space" || onMobile) {
        anchor.current = { key, ordinal: tile.ordinal };
        commit(toggleTile(current, tile.holding, tile.ordinal), clicked);
        return;
      }
      if (gesture.range && anchor.current) {
        const from = latest.current.byKey.get(anchor.current.key);
        if (from && anchor.current.ordinal < from.copies) {
          const start = from.start + anchor.current.ordinal;
          const base = gesture.toggle ? current : EMPTY_SELECTION;
          commit(
            addSpans(base, latest.current.holdings, [
              [Math.min(start, tile.index), Math.max(start, tile.index)],
            ]),
            clicked
          );
          return;
        }
      }
      anchor.current = { key, ordinal: tile.ordinal };
      if (gesture.toggle)
        commit(toggleTile(current, tile.holding, tile.ordinal), clicked);
      else if (isOnlyTile(current, key, tile.ordinal)) commit(EMPTY_SELECTION);
      else commit(onlyTile(tile.holding, tile.ordinal), clicked);
    },
    [commit]
  );

  const marquee = useCallback(
    (event: MarqueeEvent) => {
      if (event.phase === "start") {
        marqueeBase.current = event.additive
          ? latest.current.selected
          : EMPTY_SELECTION;
        commit(marqueeBase.current);
      } else if (event.phase === "move") {
        commit(
          addSpans(marqueeBase.current, latest.current.holdings, event.spans)
        );
      } else marqueeBase.current = EMPTY_SELECTION;
    },
    [commit]
  );

  const hover = useCallback((tile: TileRef | null) => {
    setHovered(tile ? { holding: tile.holding, ordinal: tile.ordinal } : null);
  }, []);

  // Changing what the gallery lists (Location, search, filters) clears the selection; sorting doesn't.
  useEffect(() => {
    clear();
    setHovered(null);
    setDetails(null);
  }, [scope, clear]);

  // Once the listing is complete, drop selected copies it no longer has (another tab, a reload).
  // Not before: a re-sort empties the gallery while it reloads, and the selection must survive that.
  useEffect(() => {
    if (status !== "ready") return;
    const next = reconcileSelection(latest.current.selected, byKey);
    if (next !== latest.current.selected) commit(next);
  }, [status, byKey, commit]);

  // Escape clears the selection unless a dialog, drawer or sheet is open (they handle Escape themselves).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelector("dialog[open], [aria-modal='true']")) return;
      if (latest.current.selected.size) clear();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [clear]);

  // The details sheet is mobile only.
  useEffect(() => {
    if (!mobile) setDetails(null);
  }, [mobile]);

  // Show the current listing's copy of a Holding (its quantity may have changed since it was picked).
  const fresh = (card: Inspected | null): Inspected | null =>
    card
      ? {
          holding: byKey.get(card.holding.key) ?? card.holding,
          ordinal: card.ordinal,
        }
      : null;
  const summary = useMemo(() => summarizeSelection(selected), [selected]);
  const openDetails = useCallback(() => {
    const card = latest.current.focus;
    if (card) setDetails(card);
  }, []);
  const closeDetails = useCallback(() => setDetails(null), []);

  return {
    selected,
    summary,
    inspected: fresh(selected.size ? focus : hovered),
    details: fresh(details),
    selectMode,
    setSelectMode,
    clear,
    activate,
    hover,
    marquee,
    openDetails,
    closeDetails,
  };
}
