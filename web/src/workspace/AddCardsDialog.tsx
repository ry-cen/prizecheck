import { useEffect, useId, useRef, useState } from "react";
import { AddCardsForm } from "../AddCardsForm";
import { Button } from "../ui/Button";
import { OLD_BUTTONS, OLD_FIELDS, OLD_TEXT } from "./legacyContent";
import { focusWorkspaceHeading } from "./SelectionBar";

// The existing AddCardsForm, styled from here so its markup stays unchanged: each form wraps its labelled
// fields and its button on one line, the fields full width under their labels.
const FORM = `${OLD_BUTTONS} ${OLD_FIELDS} ${OLD_TEXT} flex flex-col gap-4 [&_form]:m-0 [&_form]:flex [&_form]:flex-wrap [&_form]:items-end [&_form]:gap-3 [&_label]:flex [&_label]:min-w-0 [&_label]:flex-[1_1_200px] [&_label]:flex-col [&_label]:gap-2 [&_label]:text-meta [&_label]:text-text-muted [&_input]:w-full [&_select]:w-full`;

type Props = {
  locationId: string;
  /** The Location's own name, used in the success message. */
  locationName: string;
  /** The full path for the title, such as "Shelf / Binder 2". */
  path: string;
  /** Reloads the gallery and the tree after each Add. */
  onAdded: () => Promise<void>;
  onClose: () => void;
};

/** Add cards (ticket 114): the Decks page's Add form for the open Storage Leaf or Deck, in a modal dialog.
 * It stays open after each Add so several Editions can be added in a row. Its status line is always mounted.
 * It stays a hand-rolled <dialog> (focus on its search field, focus to the heading when its opener is gone)
 * until #175 replaces it with Catalog's Add mode. */
export function AddCardsDialog({
  locationId,
  locationName,
  path,
  onAdded,
  onClose,
}: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const pressedBackdrop = useRef(false);
  const titleId = useId();
  const [message, setMessage] = useState("");

  // As in CreateLocationDialog: open modally, focus the search field, return focus to the opener on close, or to the heading when the opener is gone.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    if (!dialog.open) dialog.showModal();
    dialog.querySelector<HTMLInputElement>("input")?.focus();
    return () => {
      if (dialog.open) dialog.close();
      if (opener?.isConnected && opener.getClientRects().length) opener.focus();
      else {
        // The Add cards button goes with its Location (deleted, or now a folder): keep focus off the page body.
        const active = document.activeElement;
        if (!active || active === document.body || !active.isConnected)
          focusWorkspaceHeading();
      }
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      // A centred panel on desktop and a bottom sheet on a phone, as the kit Dialog draws them. Every property
      // the browser styles a dialog with is set here (no Preflight).
      className="m-auto box-border h-fit max-h-[85dvh] w-[min(480px,calc(100vw-var(--space-8)))] max-w-none overflow-auto rounded-dialog border border-solid border-border-strong bg-surface p-0 font-sans text-body leading-(--line-height) text-text backdrop:bg-scrim phone:mx-0 phone:mt-auto phone:mb-0 phone:w-full phone:rounded-b-none phone:border-x-0 phone:border-b-0"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={() => {
        if (!dialogRef.current?.open) onClose();
      }}
      onPointerDown={(event) => {
        pressedBackdrop.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        const backdrop =
          pressedBackdrop.current && event.target === event.currentTarget;
        pressedBackdrop.current = false;
        if (backdrop) onClose();
      }}
    >
      <div className="flex flex-col gap-4 p-6">
        <h2 id={titleId} className="m-0 text-heading font-[550] wrap-anywhere">
          Add cards to {path}
        </h2>
        <div className={FORM}>
          <AddCardsForm
            locationId={locationId}
            locationName={locationName}
            onMessage={setMessage}
            onAdded={onAdded}
          />
        </div>
        {/* Always in the layout, never display:none, so screen readers announce each message. */}
        <p className="m-0 min-h-[1lh] text-meta text-text-muted" role="status">
          {message}
        </p>
        <div className="flex justify-end">
          <Button onClick={onClose}>Close</Button>
        </div>
      </div>
    </dialog>
  );
}
