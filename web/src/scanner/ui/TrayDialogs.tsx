import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import {
  clearBody,
  CLEAR_TRAY,
  DESTINATION_HELP,
  KEEP_CARDS,
  NOT_NOW,
  PUT_CARDS_IN,
  REVIEW_TRAY,
  TRAY_FULL,
} from "./copy";
import type { Place } from "./useDestinations";

/** Put cards in: the Storage Leaves that are not Decks. After DESTINATION_CHANGED it also says nothing was added. */
export function DestinationDialog({
  leaves,
  value,
  note,
  onChoose,
  onClose,
}: {
  leaves: Place[];
  value: string | null;
  note: string | null;
  onChoose: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      open
      onClose={onClose}
      title={PUT_CARDS_IN}
      closeLabel="Close Put cards in"
    >
      <div className="flex flex-col gap-3 p-4">
        {note && (
          <p role="status" className="m-0 text-body text-text-muted">
            {note}
          </p>
        )}
        <div
          role="radiogroup"
          aria-label={PUT_CARDS_IN}
          className="flex flex-col gap-1"
        >
          {leaves.map((leaf) => (
            <button
              key={leaf.id}
              type="button"
              role="radio"
              aria-checked={leaf.id === value}
              onClick={() => onChoose(leaf.id)}
              className="box-border flex min-h-control w-full cursor-pointer items-center rounded-control border border-border-strong bg-surface-raised px-3 text-left font-sans text-control text-text hover:border-control-outline aria-checked:border-accent-border aria-checked:bg-accent-wash aria-checked:text-accent-strong phone:min-h-tap"
            >
              {leaf.label}
            </button>
          ))}
        </div>
        <p className="m-0 text-meta text-text-muted">{DESTINATION_HELP}</p>
      </div>
    </Dialog>
  );
}

export function ClearDialog({
  copies,
  onClear,
  onClose,
}: {
  copies: number;
  onClear: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      open
      onClose={onClose}
      title="Clear the tray?"
      closeLabel="Close Clear tray"
    >
      <div className="flex flex-col gap-3 p-4">
        <p className="m-0 text-body text-text-muted">{clearBody(copies)}</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="danger" onClick={onClear}>
            {CLEAR_TRAY}
          </Button>
          <Button data-autofocus onClick={onClose}>
            {KEEP_CARDS}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/** The full-tray prompt. Scanning stays paused while it is open. */
export function FullPrompt({
  onReview,
  onClose,
}: {
  onReview: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog open onClose={onClose} title={TRAY_FULL} closeLabel="Close">
      <div className="flex flex-wrap gap-2 p-4">
        <Button variant="primary" data-autofocus onClick={onReview}>
          {REVIEW_TRAY}
        </Button>
        <Button variant="quiet" onClick={onClose}>
          {NOT_NOW}
        </Button>
      </div>
    </Dialog>
  );
}
