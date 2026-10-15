import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "./Button";
import { Dialog } from "./Dialog";

type Props = {
  /** Shown while true. The parent owns this state and sets it false in onClose. */
  open: boolean;
  onClose: () => void;
  /** The card's name: the heading, and the popup's accessible name. */
  title: string;
  /** The close button's accessible name. */
  closeLabel?: string;
  /** Where the card sits in the results ("‹ N / M ›"; index from 0), or null to hide the stepping controls (a card
   * opened on its own, such as from a link). */
  position: { index: number; total: number } | null;
  canPrevious: boolean;
  canNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
  /** Changes whenever the popup shows another card (its Edition id). After a step, focus that fell out of the
   * popup (the focused control belonged to the previous card) moves to the stepping controls. */
  cardKey: string;
  /** Announced politely after each step, for example "Card 3 of 70: Bulbasaur". */
  announcement?: string;
  /** The artwork column. */
  art: ReactNode;
  /** The details column. */
  children: ReactNode;
  /** A quiet footer under both columns (Catalog's report links). */
  footer?: ReactNode;
  returnFocus?: RefObject<HTMLElement | null>;
};

/** Arrow keys that belong to the focused control (text, a select, a slider or a menu) never step. */
const OWNS_ARROWS =
  "input, select, textarea, [contenteditable=''], [contenteditable='true'], [role='slider'], [role='listbox'], [role='menu'], [role='radiogroup'], [role='tablist']";

/**
 * The card popup (spec "Styling and the kit": CardPopup; #174): a Dialog that is a centred panel on desktop and a
 * bottom sheet on a phone, with "‹ N / M ›" beside ✕, and ← → stepping through the results while focus isn't in a
 * control that uses the arrows itself. The artwork sits beside the details, with a footer under both.
 *
 * It only lays out and steps. The page fills the columns and owns the data and the actions: Catalog's Browse popup
 * (catalog/CatalogCardPopup), the deck builder's library (#177) and the read-only published deck (#182) each pass
 * their own details and action rows.
 */
export function CardPopup({
  open,
  onClose,
  title,
  closeLabel = "Close card details",
  position,
  canPrevious,
  canNext,
  onPrevious,
  onNext,
  cardKey,
  announcement = "",
  art,
  children,
  footer,
  returnFocus,
}: Props) {
  const root = useRef<HTMLDivElement>(null);
  const previous = useRef<HTMLButtonElement>(null);
  const next = useRef<HTMLButtonElement>(null);
  // The announcement is spoken only after a step, not when the popup opens (the dialog's name is read then).
  const [spoken, setSpoken] = useState("");
  const shownKey = useRef<string | null>(null);

  // ← → step through the results. Keydown reaches the document from inside the dialog, and from the body when
  // focus was lost.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      if (
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
      )
        return;
      const target = event.target;
      const dialog = root.current?.closest("dialog");
      if (target instanceof Element) {
        if (target !== document.body && !dialog?.contains(target)) return;
        if (target.closest(OWNS_ARROWS)) return;
      }
      event.preventDefault();
      if (event.key === "ArrowLeft" && canPrevious) onPrevious();
      if (event.key === "ArrowRight" && canNext) onNext();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, canPrevious, canNext, onPrevious, onNext]);

  // A step replaced the focused control: keep focus in the popup, on the way it was stepping.
  useLayoutEffect(() => {
    if (!open) {
      shownKey.current = null;
      setSpoken("");
      return;
    }
    const stepped = shownKey.current !== null && shownKey.current !== cardKey;
    shownKey.current = cardKey;
    if (!stepped) return;
    setSpoken(announcement);
    const dialog = root.current?.closest("dialog");
    const active = document.activeElement;
    // Lost: outside the popup (the control went with the previous card), or on a step button now disabled (the end).
    const lost =
      !dialog?.contains(active) ||
      (active instanceof HTMLButtonElement && active.disabled);
    if (!dialog || !lost) return;
    const target =
      [next.current, previous.current].find(
        (button) => button && !button.disabled
      ) ?? dialog;
    target.focus();
  }, [open, cardKey, announcement]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      closeLabel={closeLabel}
      size="card"
      returnFocus={returnFocus}
      headerActions={
        position && (
          <div
            role="group"
            aria-label="Step through the results"
            className="flex items-center"
          >
            <Button
              ref={previous}
              variant="quiet"
              icon={ChevronLeft}
              label="Previous card"
              disabled={!canPrevious}
              onClick={onPrevious}
            />
            <span className="box-content min-w-14 px-1 text-center text-meta tabular-nums text-text-muted">
              {(position.index + 1).toLocaleString()} /{" "}
              {position.total.toLocaleString()}
            </span>
            <Button
              ref={next}
              variant="quiet"
              icon={ChevronRight}
              label="Next card"
              disabled={!canNext}
              onClick={onNext}
            />
          </div>
        )
      }
    >
      <div ref={root} className="flex flex-col gap-4 text-body">
        <div className="flex gap-4 phone:gap-3">
          <div className="flex w-44 shrink-0 flex-col gap-2 phone:w-28">
            {art}
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-4">{children}</div>
        </div>
        {footer && <div className="border-t border-border pt-3">{footer}</div>}
        <p aria-live="polite" className="sr-only">
          {spoken}
        </p>
      </div>
    </Dialog>
  );
}

/** The card's artwork at full width of its column, or "Artwork unavailable" when there is none or it fails. */
export function CardArt({ url, name }: { url: string | null; name: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  if (!url || failed)
    return (
      <div
        role="img"
        aria-label={`Artwork unavailable for ${name}`}
        className="box-border flex aspect-(--tile-aspect) w-full items-center justify-center rounded-card bg-surface-raised p-2 text-center text-caption text-text-muted"
      >
        Artwork unavailable
      </div>
    );
  return (
    <img
      src={url}
      alt={`${name} card art`}
      onError={() => setFailed(true)}
      className="block aspect-(--tile-aspect) w-full rounded-card object-contain"
    />
  );
}
