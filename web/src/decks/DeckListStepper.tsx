import { Button } from "../ui/Button";
import type { EditFeedback } from "./useDeckListEdits";

/**
 * −1 / N on Deck List / +1 (#177, spec "Deck builder": the card popup and the copy sheet). N is the Edition's
 * quantity as the collector expects it, edits on their way included, so every tap shows at once. +1 is never
 * blocked (a Deck List can go over 60); −1 stops at none.
 */
export function DeckListStepper({
  quantity,
  onChange,
}: {
  quantity: bigint;
  onChange: (delta: bigint) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Deck List copies"
      className="flex flex-wrap items-center gap-2"
    >
      <Button disabled={quantity <= 0n} onClick={() => onChange(-1n)}>
        −1
      </Button>
      <span aria-live="polite" className="text-body tabular-nums">
        <strong className="font-semibold">{quantity.toString()}</strong> on Deck
        List
      </span>
      <Button onClick={() => onChange(1n)}>+1</Button>
    </div>
  );
}

/**
 * The last edit's words and its Undo inside an open dialog (the card popup, the copy sheet): the toast host is inert
 * behind a modal, so the dialog repeats the toast. Only edits made since the dialog opened (`since`) show.
 */
export function EditFeedbackLine({
  feedback,
  since,
}: {
  feedback: EditFeedback | null;
  since: number;
}) {
  const shown = feedback && feedback.id > since ? feedback : null;
  return (
    <div className="flex min-h-control flex-wrap items-center gap-2 text-meta">
      <p role="status" className="m-0 min-w-0 grow">
        {shown?.message ?? ""}
      </p>
      {shown && (shown.undo || shown.busy) && (
        <Button
          variant="quiet"
          aria-disabled={shown.busy || undefined}
          onClick={() => shown.undo?.()}
        >
          Undo
        </Button>
      )}
    </div>
  );
}
