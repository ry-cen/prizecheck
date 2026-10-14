import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";

/** Pointer travel, in px, that turns a press into a drag. Less is a tap. */
const DRAG_THRESHOLD = 6;
const BADGE_OFFSET_X = 14;
const BADGE_OFFSET_Y = 10;

/** The two places a drag can end: the Deck List (adds a copy) and the library (takes one off). */
export type DeckDropTarget = "deck" | "library";

/** What a drag carries: one copy of an Edition, from the library (to add) or from the Deck List (to take off). */
export type DeckDragPayload = {
  from: DeckDropTarget;
  editionId: string;
  name: string;
};

export type DeckDragging = {
  payload: DeckDragPayload;
  /** Where a drop would land: the side the copy isn't on. */
  target: DeckDropTarget;
  over: boolean;
  x: number;
  y: number;
  text: string;
};

/** While a card is dragged the pointer shows a closed hand and nothing on the page selects as text. */
function setDraggingLook(on: boolean) {
  document.body.style.cursor = on ? "grabbing" : "";
  document.body.style.userSelect = on ? "none" : "";
  document.body.style.setProperty("-webkit-user-select", on ? "none" : "");
}

/** Swallows the click that follows a drag's pointerup, so the drag doesn't also open the popup or the sheet. */
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

/**
 * The deck builder's card drag (#177, spec "Deck builder": dragging), with pointer events as Collection's tile drag
 * (workspace/tileDrag): mouse and pen only, never touch, starting after 6 px. A library tile dropped on the Deck List
 * adds one copy of its Edition; a copy dropped on the library takes one off. A badge follows the pointer, the
 * target (an element with `data-deck-drop="deck"` or `"library"`) is outlined, and the one under the pointer is
 * filled. Escape cancels, and the click after a drag is swallowed. Touch uses taps: every drag has a tap equivalent
 * (the card popup's +1, the copy sheet's −1).
 */
export function useDeckDrag({
  enabled,
  onDrop,
}: {
  /** Desktop only: on a phone the Deck List and the library are separate tabs. */
  enabled: boolean;
  onDrop: (payload: DeckDragPayload) => void;
}) {
  const [dragging, setDragging] = useState<DeckDragging | null>(null);
  const live = useRef({ enabled, onDrop });
  live.current = { enabled, onDrop };
  const stopActive = useRef<(() => void) | null>(null);
  useEffect(() => () => stopActive.current?.(), []);

  const start = useCallback(
    (payload: DeckDragPayload, event: React.PointerEvent<HTMLElement>) => {
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
      const target: DeckDropTarget =
        payload.from === "library" ? "deck" : "library";
      const text = `${payload.from === "library" ? "+1" : "−1"} ${payload.name}`;
      let begun = false;
      let cancelled = false;
      let over = false;
      // The badge follows the pointer through its element, not React state: state changes only when the drag begins
      // or the pointer crosses into or out of the target.
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
      const onMove = (move: PointerEvent) => {
        if (move.pointerId !== pointerId || cancelled) return;
        if (!begun) {
          if (
            Math.hypot(move.clientX - startX, move.clientY - startY) <
            DRAG_THRESHOLD
          )
            return;
          begun = true;
          setDraggingLook(true);
        }
        const under = document
          .elementFromPoint(move.clientX, move.clientY)
          ?.closest<HTMLElement>("[data-deck-drop]");
        const next = under?.dataset.deckDrop === target;
        pointer = { x: move.clientX, y: move.clientY };
        if (!shown || next !== over) {
          shown = true;
          over = next;
          stopBadge();
          setDragging({
            payload,
            target,
            over,
            x: pointer.x,
            y: pointer.y,
            text,
          });
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
        const dropped = begun && !cancelled && over;
        const wasDrag = begun;
        stop();
        if (!wasDrag) return; // No drag happened: the click goes through.
        swallowNextClick();
        if (dropped) live.current.onDrop(payload);
      };
      const onCancel = (cancel: PointerEvent) => {
        if (cancel.pointerId === pointerId) stop();
      };
      const onKey = (key: KeyboardEvent) => {
        if (key.key !== "Escape" || !begun || cancelled) return;
        // Escape drops the drag; the pointerup that follows does nothing.
        key.preventDefault();
        key.stopPropagation();
        cancelled = true;
        shown = false;
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

  return { start, dragging };
}

/** A drop target's look while a drag could land on it: a dashed outline, and a solid one with a wash while the
 * pointer is over it (shape as well as colour), as Collection's sidebar drop targets. */
export function dropLook(
  dragging: DeckDragging | null,
  target: DeckDropTarget
): string {
  if (!dragging || dragging.target !== target) return "";
  return dragging.over
    ? " outline-2 outline-solid outline-accent -outline-offset-2 bg-accent-wash"
    : " outline-2 outline-dashed outline-accent-outline -outline-offset-2";
}

/** The copy that follows the pointer during a drag, such as "+1 Charizard ex". */
export function DeckDragBadge({ dragging }: { dragging: DeckDragging | null }) {
  if (!dragging) return null;
  return (
    <div
      data-drag-badge=""
      aria-hidden="true"
      className="pointer-events-none fixed z-(--layer-toast) box-border whitespace-nowrap rounded-round border border-accent-border bg-surface-raised px-3 py-1 font-sans text-meta font-semibold text-text tabular-nums"
      style={{
        left: dragging.x + BADGE_OFFSET_X,
        top: dragging.y + BADGE_OFFSET_Y,
      }}
    >
      {dragging.text}
    </div>
  );
}
