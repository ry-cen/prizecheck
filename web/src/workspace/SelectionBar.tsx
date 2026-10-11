import React, {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { plural } from "./galleryModel";
import type { SelectionSummary } from "./selectionModel";
import "./Selection.css";

/** Moves keyboard focus to the workspace heading without scrolling. Used when the control that had
 * focus goes away: the selection bar after Clear or a successful action, or a dialog that closed. */
export function focusWorkspaceHeading() {
  const heading = document.getElementById("ws-heading");
  if (!heading) return;
  if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
  heading.focus({ preventScroll: true });
}

type Props = {
  summary: SelectionSummary;
  onClear: () => void;
  /** Opens the details sheet for the last clicked selected card (mobile). */
  onDetails: () => void;
  /** Ticket 107: Actions → Move… and Inventory Removal… open their dialogs. */
  onMove: () => void;
  onRemove: () => void;
  /** An action is running: Actions is unavailable until it settles. */
  busy: boolean;
  /** Progress of a drag Move (live, polite). */
  status: string;
  /** A failed drag Move, naming the affected Location. */
  error: string;
  /** The Actions button, so focus can return to it when a dialog is cancelled. */
  actionsRef: React.RefObject<HTMLButtonElement | null>;
};

/** The selection bar: floating at the bottom centre on desktop, a compact strip on mobile.
 * Shown only while one or more copies are selected. */
export function SelectionBar({
  summary,
  onClear,
  onDetails,
  onMove,
  onRemove,
  busy,
  status,
  error,
  actionsRef,
}: Props) {
  const [open, setOpen] = useState(false);
  const barRef = useRef<HTMLElement>(null);
  const menuId = useId();

  // A press anywhere outside the bar closes the Actions list.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!barRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);
  useEffect(() => {
    if (busy) setOpen(false);
  }, [busy]);

  // The bar unmounts when the selection empties (Clear, Escape, a successful action). If it held
  // focus, focus would fall to the page, so it moves to the heading first.
  useLayoutEffect(() => {
    const bar = barRef.current;
    return () => {
      if (bar?.contains(document.activeElement)) focusWorkspaceHeading();
    };
  }, []);

  function choose(action: () => void) {
    setOpen(false);
    action();
  }

  return (
    <section
      ref={barRef}
      className="ws-selection-bar"
      aria-label="Selection"
      onKeyDown={(event) => {
        // Escape closes the Actions list only; preventDefault keeps the selection.
        if (event.key !== "Escape" || !open) return;
        event.preventDefault();
        setOpen(false);
        actionsRef.current?.focus();
      }}
    >
      <p className="ws-selection-text">
        <strong>{plural(summary.copies, "copy", "copies")} selected</strong>
        <span className="ws-selection-detail">
          {plural(summary.editions, "edition", "editions")} ·{" "}
          {plural(summary.locations, "location", "locations")}
        </span>
      </p>
      <span className="ws-selection-actions">
        <button type="button" className="ws-mobile-only" onClick={onDetails}>
          Details
        </button>
        <span className="ws-actions">
          <button
            ref={actionsRef}
            type="button"
            aria-expanded={open}
            aria-controls={open ? menuId : undefined}
            aria-disabled={busy || undefined}
            onClick={() => {
              if (!busy) setOpen(!open);
            }}
          >
            Actions <span aria-hidden="true">▾</span>
          </button>
          {open && (
            <span
              id={menuId}
              className="ws-actions-list"
              role="group"
              aria-label="Actions"
            >
              <button type="button" onClick={() => choose(onMove)}>
                Move…
              </button>
              <button type="button" onClick={() => choose(onRemove)}>
                Inventory Removal…
              </button>
              <button type="button" onClick={() => choose(onClear)}>
                Clear selection
              </button>
            </span>
          )}
        </span>
      </span>
      <p className="ws-selection-status" role="status">
        {status}
      </p>
      {error && (
        <p className="ws-selection-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
