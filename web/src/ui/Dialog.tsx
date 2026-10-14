import React, { useId, useLayoutEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { focusableIn } from "./focusable";
import { Icon } from "./Icon";

type Props = {
  /** Shown as a modal while true. The parent owns this state and sets it false in onClose. */
  open: boolean;
  /** Escape, the close button, a press on the scrim, or the browser closing the dialog. */
  onClose: () => void;
  /** The visible heading; it is also the dialog's accessible name. */
  title: string;
  /** The close button's accessible name, for example "Close locations". */
  closeLabel?: string;
  /** "left": a full-height drawer along the left edge at every width (a page's side content); "right": the
   * same along the right edge (a page's header panel, such as Collection's Filters & display). Without it
   * the dialog is centred on desktop and a bottom sheet on a phone (760 px or narrower). */
  side?: "left" | "right";
  /** "wide": a centred panel up to 760 px wide on desktop that fills the screen on a phone, for a dialog
   * that holds a long list (Manage locations). Ignored with `side`. */
  size?: "wide";
  /** The scrolling content box, for a dialog that scrolls it itself (a drag that scrolls near its edges). */
  bodyRef?: React.Ref<HTMLDivElement>;
  /** Layout classes for the content box (scroll padding). Never colours or sizes. */
  bodyClassName?: string;
  /** Where focus goes when it closes. Preferred over whatever had focus when it opened, because Safari
   * doesn't focus a button on click or tap, so the opener isn't always document.activeElement. */
  returnFocus?: React.RefObject<HTMLElement | null>;
  children: ReactNode;
};

// Without Preflight the browser's own dialog styles (border, padding, margin, maximum sizes, colours) apply,
// so every one of them is set here. Each property is set once per width, so no two classes compete.
const FRAME =
  "flex-col overflow-hidden bg-surface p-0 text-text backdrop:bg-scrim open:flex";
const CENTRED =
  "inset-0 m-auto h-fit max-h-[calc(100dvh-var(--space-16))] w-dialog max-w-[calc(100vw-var(--space-8))] rounded-dialog border border-border-strong phone:inset-x-0 phone:top-auto phone:bottom-0 phone:m-0 phone:max-h-[85dvh] phone:w-full phone:max-w-none phone:rounded-b-none phone:border-x-0 phone:border-b-0";
const LEFT =
  "inset-y-0 left-0 right-auto m-0 h-dvh max-h-none w-drawer max-w-none rounded-none border-y-0 border-l-0 border-r border-border-strong";
const RIGHT =
  "inset-y-0 right-0 left-auto m-0 h-dvh max-h-none w-drawer max-w-none rounded-none border-y-0 border-r-0 border-l border-border-strong";
const WIDE =
  "inset-0 m-auto h-fit max-h-[min(860px,calc(100dvh-var(--space-8)-var(--space-8)))] w-[min(760px,calc(100vw-var(--space-6)-var(--space-6)))] max-w-none rounded-dialog border border-border-strong phone:h-dvh phone:max-h-none phone:w-full phone:rounded-none phone:border-0";

/**
 * The kit's one dialog, on the native <dialog> element (ADR 0012). It opens with showModal(), so the
 * rest of the page is inert and the scrim is the ::backdrop. It moves focus to its first control, or to
 * the element marked data-autofocus (React's autoFocus writes no attribute, and its own focus call runs
 * before the dialog is shown, so it can't be used here), keeps Tab inside, closes on Escape, the close
 * button and a press on the scrim, and returns focus to the element that had it when it opened. It has
 * no entry animation.
 */
export function Dialog({
  open,
  onClose,
  title,
  closeLabel = "Close",
  side,
  size,
  returnFocus,
  bodyRef,
  bodyClassName,
  children,
}: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const pressedScrim = useRef(false);
  const openRef = useRef(open);
  openRef.current = open;

  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!open || !dialog) return;
    const returnTo =
      returnFocus?.current ??
      (document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null);
    if (!dialog.open) dialog.showModal();
    const first =
      dialog.querySelector<HTMLElement>("[autofocus], [data-autofocus]") ??
      focusableIn(dialog)[0] ??
      dialog;
    first.focus();
    // The page behind a modal doesn't scroll.
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = overflow;
      if (dialog.open) dialog.close();
      if (returnTo?.isConnected && returnTo.getClientRects().length)
        returnTo.focus({ preventScroll: true });
    };
  }, [open]);

  function onKeyDown(event: React.KeyboardEvent<HTMLDialogElement>) {
    if (event.key === "Escape") {
      // A control inside that takes Escape itself (a drag in progress, a confirmation inside the dialog)
      // calls preventDefault first; the dialog then stays open (#166).
      if (event.defaultPrevented) return;
      // Handled here so the browser's own cancel never runs, and so document-level Escape handlers
      // (Collection's selection) see it as taken.
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const items = focusableIn(event.currentTarget);
    if (!items.length) {
      event.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    const inside = event.currentTarget.contains(active);
    if (event.shiftKey && (active === first || !inside)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !inside)) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      className={`${FRAME} ${side === "left" ? LEFT : side === "right" ? RIGHT : size === "wide" ? WIDE : CENTRED}`}
      onKeyDown={onKeyDown}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={() => {
        // The browser can close a modal itself (a repeated Escape); keep the parent's state in step.
        if (openRef.current) onClose();
      }}
      onPointerDown={(event) => {
        pressedScrim.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        // A press on the ::backdrop targets the <dialog> itself; the content fills the rest of it.
        if (pressedScrim.current && event.target === event.currentTarget)
          onClose();
        pressedScrim.current = false;
      }}
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center justify-between gap-2 border-b border-border py-2 pl-4 pr-2">
          <h2 id={titleId} className="m-0 text-heading font-semibold">
            {title}
          </h2>
          <button
            type="button"
            aria-label={closeLabel}
            onClick={onClose}
            className="inline-flex size-control cursor-pointer items-center justify-center rounded-control border-0 bg-transparent p-0 text-text-muted hover:bg-surface-raised hover:text-text phone:size-tap"
          >
            <Icon icon={X} size={18} />
          </button>
        </div>
        <div
          ref={bodyRef}
          className={`min-h-0 flex-1 overflow-auto p-4${bodyClassName ? ` ${bodyClassName}` : ""}`}
        >
          {children}
        </div>
      </div>
    </dialog>
  );
}
