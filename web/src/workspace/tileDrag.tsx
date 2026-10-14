import React, { useCallback, useEffect, useRef, useState } from "react";
import type { TileRef } from "./galleryModel";
import { carriedText } from "./inventoryActionsModel";
import type { DropTargets } from "./LocationNav";
import { isFolder, type LocationIndex } from "./locationTree";
import {
  isTileSelected,
  selectedGroups,
  type SelectedGroup,
} from "./selectionModel";
import type { SelectionState } from "./useSelection";

/** Pointer travel, in px, that turns a press on a tile into a drag. Less is a click. */
const DRAG_THRESHOLD = 6;
/** The badge sits just below and right of the pointer. */
const BADGE_OFFSET_X = 14;
const BADGE_OFFSET_Y = 10;

type Options = {
  /** Desktop only, and not while an action runs. */
  enabled: boolean;
  index: LocationIndex;
  selection: SelectionState;
  /** A drop on a valid Storage Leaf: move these groups there now. */
  onDrop: (destinationId: string, groups: SelectedGroup[]) => void;
};

type Dragging = {
  valid: ReadonlySet<string>;
  over: string | null;
  x: number;
  y: number;
  text: string;
};

/** While tiles are dragged the pointer shows a closed hand and nothing on the page selects as text. Set on
 * <body> inline, since a drag can pass over anything (#166 moved this off a body class). */
function setDraggingLook(on: boolean) {
  document.body.style.cursor = on ? "grabbing" : "";
  document.body.style.userSelect = on ? "none" : "";
  document.body.style.setProperty("-webkit-user-select", on ? "none" : "");
}

/** Swallows the click that follows a drag's pointerup, so the drag doesn't also act as a click. */
function swallowNextClick() {
  const swallow = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };
  window.addEventListener("click", swallow, { capture: true, once: true });
  window.setTimeout(
    () => window.removeEventListener("click", swallow, { capture: true }),
    0
  );
}

/** Desktop tile drag with pointer events (resolution 29). A selected tile carries the whole selection;
 * an unselected tile replaces the selection with itself and carries only that copy. A count badge
 * follows the pointer, valid sidebar Storage Leaves are highlighted, and a drop on one moves at once.
 * Listeners sit on window, so a tile that the virtualized gallery unmounts mid-drag doesn't end it.
 * Escape cancels. */
export function useTileDrag({ enabled, index, selection, onDrop }: Options) {
  const [dragging, setDragging] = useState<Dragging | null>(null);
  const live = useRef({ enabled, index, selection, onDrop });
  live.current = { enabled, index, selection, onDrop };
  const stopActive = useRef<(() => void) | null>(null);
  useEffect(() => () => stopActive.current?.(), []);

  const start = useCallback(
    (tile: TileRef, event: React.PointerEvent<HTMLElement>) => {
      if (
        !live.current.enabled ||
        event.button !== 0 ||
        event.pointerType === "touch" ||
        stopActive.current
      )
        return;
      const pointerId = event.pointerId;
      const startX = event.clientX;
      const startY = event.clientY;
      let groups: SelectedGroup[] | null = null;
      let valid: ReadonlySet<string> = new Set();
      let over: string | null = null;
      let text = "";
      let cancelled = false;
      // The badge follows the pointer through its element, not React state: state changes only when
      // the drag begins or the target under the pointer changes.
      let shown = false;
      let frame = 0;
      let pointer = { x: startX, y: startY };
      const placeBadge = () => {
        frame = 0;
        const badge = document.querySelector<HTMLElement>("[data-drag-badge]");
        if (!badge) return;
        badge.style.left = `${pointer.x + BADGE_OFFSET_X}px`;
        badge.style.top = `${pointer.y + BADGE_OFFSET_Y}px`;
      };
      const stopBadge = () => {
        if (frame) window.cancelAnimationFrame(frame);
        frame = 0;
      };

      const begin = () => {
        const { selection: current, index: tree } = live.current;
        const { holding } = tile.holding;
        if (isTileSelected(current.selected, tile.holding.key, tile.ordinal))
          groups = selectedGroups(current.selected);
        else {
          current.activate(tile, {
            kind: "click",
            toggle: false,
            range: false,
          });
          groups = [
            {
              source_id: holding.location_id,
              edition_id: holding.edition_id,
              quantity: "1",
              expected_version: holding.version,
            },
          ];
        }
        const carried = groups;
        // A Storage Leaf is a valid drop when at least one carried copy isn't already there.
        const sources = new Set(carried.map((group) => group.source_id));
        valid = new Set(
          Array.from(tree.byId.values())
            .filter(
              (node) =>
                !isFolder(node) && (sources.size > 1 || !sources.has(node.id))
            )
            .map((node) => node.id)
        );
        text = carriedText(carried);
        setDraggingLook(true);
      };
      const onMove = (move: PointerEvent) => {
        if (move.pointerId !== pointerId || cancelled) return;
        if (!groups) {
          if (
            Math.hypot(move.clientX - startX, move.clientY - startY) <
            DRAG_THRESHOLD
          )
            return;
          begin();
        }
        const row = document
          .elementFromPoint(move.clientX, move.clientY)
          ?.closest<HTMLElement>("[data-drop-target]");
        const id = row?.dataset.dropTarget ?? null;
        const next = id && valid.has(id) ? id : null;
        pointer = { x: move.clientX, y: move.clientY };
        if (!shown || next !== over) {
          shown = true;
          over = next;
          stopBadge();
          setDragging({ valid, over, x: pointer.x, y: pointer.y, text });
        } else if (!frame) frame = window.requestAnimationFrame(placeBadge);
      };
      const stop = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        window.removeEventListener("keydown", onKey, true);
        setDraggingLook(false);
        stopBadge();
        stopActive.current = null;
        setDragging(null);
      };
      const onUp = (up: PointerEvent) => {
        if (up.pointerId !== pointerId) return;
        const carried = groups;
        const target = cancelled ? null : over;
        stop();
        if (!carried) return; // No drag happened: the click goes through.
        swallowNextClick();
        if (target) live.current.onDrop(target, carried);
      };
      const onCancel = (cancel: PointerEvent) => {
        if (cancel.pointerId === pointerId) stop();
      };
      const onKey = (key: KeyboardEvent) => {
        if (key.key !== "Escape" || !groups || cancelled) return;
        // Escape drops the drag, not the selection.
        key.preventDefault();
        cancelled = true;
        setDraggingLook(false);
        stopBadge();
        setDragging(null);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
      window.addEventListener("keydown", onKey, true);
      stopActive.current = stop;
    },
    []
  );

  const drop: DropTargets | null = dragging
    ? { valid: dragging.valid, over: dragging.over }
    : null;
  return { start, drop, badge: dragging };
}

/** The compact copy and Card Edition count that follows the pointer while tiles are dragged. */
export function DragBadge({
  badge,
}: {
  badge: { x: number; y: number; text: string } | null;
}) {
  if (!badge) return null;
  return (
    <div
      data-drag-badge=""
      className="pointer-events-none fixed z-(--layer-toast) box-border rounded-round border border-accent-border bg-surface-raised px-3 py-1 font-sans text-meta font-semibold whitespace-nowrap text-text tabular-nums"
      aria-hidden="true"
      style={{ left: badge.x + BADGE_OFFSET_X, top: badge.y + BADGE_OFFSET_Y }}
    >
      {badge.text}
    </div>
  );
}
