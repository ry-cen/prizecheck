import { useEffect, useId, useRef, useState } from "react";
import { AddCardsForm } from "../AddCardsForm";
import { focusWorkspaceHeading } from "./SelectionBar";
import "./CreateLocationDialog.css";
import "./AddCardsDialog.css";

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
 * It stays open after each Add so several Editions can be added in a row. Its status line is always mounted. */
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
      className="ws-create-dialog ws-add-dialog"
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
      <div className="ws-add-cards">
        <h2 id={titleId}>Add cards to {path}</h2>
        <AddCardsForm
          locationId={locationId}
          locationName={locationName}
          onMessage={setMessage}
          onAdded={onAdded}
        />
        <p className="ws-add-status" role="status">
          {message}
        </p>
        <div className="ws-add-actions">
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </dialog>
  );
}
