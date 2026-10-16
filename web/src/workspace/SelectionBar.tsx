import React, { useEffect, useId, useLayoutEffect, useState } from "react";
import { ChevronDown, TriangleAlert } from "lucide-react";
import { Button } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { useToast } from "../ui/Toast";
import { plural } from "./galleryModel";
import { KitLayer } from "./KitLayer";
import type { SelectionSummary } from "./selectionModel";

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
  /** The bar itself, for the skip link past the cards. */
  barRef: React.RefObject<HTMLDivElement | null>;
};

const LIST_ITEM =
  "box-border flex min-h-control w-full cursor-pointer items-center rounded-control border-0 bg-transparent px-3 text-left font-sans text-control text-text hover:bg-surface-selected phone:min-h-tap";

/** The selection bar (the Actions strip): floating at the bottom centre on desktop, a compact strip above
 * the tab bar on a phone, on the kit (#165). Shown only while one or more copies are selected, and only
 * while Collection is the shown page. The toast host is raised by the bar's height, so a toast sits above
 * it at both widths, and the Borrow Request drafts tray sits above it too (useLift). Actions opens a list of buttons above it (a disclosure, not a menu: Tab walks it). */
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
  barRef,
}: Props) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const toast = useToast();

  // A press anywhere outside the bar closes the Actions list.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!barRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, barRef]);
  // An action running closes the list. Sheets and drawers are kit dialogs, which make the bar inert themselves.
  useEffect(() => {
    if (busy) setOpen(false);
  }, [busy]);

  // The toast stacks above the bar, with the bar's gap between them.
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const lift = () => {
      const gap = parseFloat(
        getComputedStyle(bar).getPropertyValue("--space-2")
      );
      toast.setLift(
        "selection",
        bar.getBoundingClientRect().height + (gap || 8)
      );
    };
    lift();
    const observer = new ResizeObserver(lift);
    observer.observe(bar);
    return () => {
      observer.disconnect();
      toast.setLift("selection", 0);
    };
  }, [toast, barRef]);

  // The bar unmounts when the selection empties (Clear, Escape, a successful action). If it held
  // focus, focus would fall to the page, so it moves to the heading first.
  useLayoutEffect(() => {
    const bar = barRef.current;
    return () => {
      if (bar?.contains(document.activeElement)) focusWorkspaceHeading();
    };
  }, [barRef]);

  function choose(action: () => void) {
    setOpen(false);
    action();
  }

  return (
    <KitLayer>
      <div
        ref={barRef}
        id="ws-dock"
        role="region"
        aria-label="Selection"
        // While the list is open the bar rises to the toast's layer: drawn after the toast host, it
        // paints over a toast, as the list did when both sat in one dock. Closed, it stays below sheets.
        className={`${open ? "z-(--layer-toast)" : "z-(--layer-sticky)"} fixed bottom-6 left-1/2 box-border flex max-w-[calc(100vw-var(--space-8))] -translate-x-1/2 flex-wrap items-center gap-4 rounded-panel border border-border-strong bg-surface-raised py-2 pl-4 pr-2 text-body text-text phone:inset-x-2 phone:bottom-[calc(var(--layout-tabbar-height)+var(--space-2))] phone:max-w-none phone:translate-x-0 phone:justify-between phone:gap-2 phone:py-1 phone:pl-3 phone:pr-1`}
        onKeyDown={(event) => {
          // Escape closes the Actions list only; preventDefault keeps the selection.
          if (event.key !== "Escape" || !open) return;
          event.preventDefault();
          setOpen(false);
          actionsRef.current?.focus();
        }}
      >
        <p className="m-0 flex min-w-0 items-baseline gap-3 whitespace-nowrap tabular-nums phone:flex-col phone:items-start phone:gap-0">
          <strong className="font-semibold">
            {plural(summary.copies, "copy", "copies")} selected
          </strong>
          <span className="text-meta text-text-muted phone:text-micro">
            {plural(summary.editions, "edition", "editions")} ·{" "}
            {plural(summary.locations, "location", "locations")}
          </span>
        </p>
        <span className="flex items-center gap-2">
          {/* Details is for a phone, where the inspector is a sheet. */}
          <span className="hidden phone:contents">
            <Button onClick={onDetails}>Details</Button>
          </span>
          <span className="relative inline-flex">
            <Button
              ref={actionsRef}
              aria-expanded={open}
              aria-controls={open ? menuId : undefined}
              aria-disabled={busy || undefined}
              onClick={() => {
                if (!busy) setOpen(!open);
              }}
            >
              Actions <Icon icon={ChevronDown} size={14} />
            </Button>
            {open && (
              <span
                id={menuId}
                className="absolute bottom-[calc(100%+var(--space-2))] right-0 z-1 box-border flex min-w-50 flex-col gap-1 rounded-panel border border-border-strong bg-surface-raised p-1 phone:min-w-55"
                role="group"
                aria-label="Actions"
              >
                <button
                  type="button"
                  className={LIST_ITEM}
                  onClick={() => choose(onMove)}
                >
                  Move…
                </button>
                <button
                  type="button"
                  className={LIST_ITEM}
                  onClick={() => choose(onRemove)}
                >
                  Inventory Removal…
                </button>
                <button
                  type="button"
                  className={LIST_ITEM}
                  onClick={() => choose(onClear)}
                >
                  Clear selection
                </button>
              </span>
            )}
          </span>
        </span>
        <p
          className="m-0 max-w-105 shrink-0 grow basis-full text-meta whitespace-normal text-text-muted empty:sr-only phone:max-w-none"
          role="status"
        >
          {status}
        </p>
        {error && (
          <p
            className="m-0 flex max-w-105 shrink-0 grow basis-full items-start gap-1 text-meta whitespace-normal text-danger phone:max-w-none"
            role="alert"
          >
            <Icon icon={TriangleAlert} size={14} className="mt-px shrink-0" />
            <span>{error}</span>
          </p>
        )}
      </div>
    </KitLayer>
  );
}
