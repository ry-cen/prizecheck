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
import "./InventoryActions.css";

/** Pointer travel, in px, that turns a press on a tile into a drag. Less is a click. */
const DRAG_THRESHOLD = 6;

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
        valid = new Set(
          Array.from(tree.byId.values())
            .filter(
              (node) =>
                !isFolder(node) &&
                carried.some((group) => group.source_id !== node.id)
            )
            .map((node) => node.id)
        );
        text = carriedText(carried);
        document.body.classList.add("ws-tile-dragging");
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
          ?.closest<HTMLElement>("[data-ws-drop]");
        const id = row?.dataset.wsDrop ?? null;
        over = id && valid.has(id) ? id : null;
        setDragging({ valid, over, x: move.clientX, y: move.clientY, text });
      };
      const stop = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        window.removeEventListener("keydown", onKey, true);
        document.body.classList.remove("ws-tile-dragging");
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
        document.body.classList.remove("ws-tile-dragging");
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
      className="ws-drag-badge"
      aria-hidden="true"
      style={{ left: badge.x + 14, top: badge.y + 10 }}
    >
      {badge.text}
    </div>
  );
}
