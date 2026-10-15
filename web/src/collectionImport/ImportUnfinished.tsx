import type { RefObject } from "react";
import type { CollectionImportSummary } from "../collection_import_generated";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { unfinishedText } from "./importText";

const PANEL =
  "box-border flex flex-col gap-2 rounded-panel border border-border bg-surface p-4";

/** The upload's Unfinished import panel (#233): the collector's open import draft, which Continue import reopens with
 * every fix kept. Starting a new import replaces it, after ReplaceImportDialog asks. */
export function UnfinishedImport({
  summary,
  busy,
  onContinue,
}: {
  summary: CollectionImportSummary;
  busy: boolean;
  onContinue: () => void;
}) {
  return (
    <section aria-labelledby="import-unfinished-heading" className={PANEL}>
      <h2
        id="import-unfinished-heading"
        className="m-0 text-heading font-semibold"
      >
        Unfinished import
      </h2>
      <p className="m-0 text-body">{unfinishedText(summary)}</p>
      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={busy} onClick={onContinue}>
          Continue import
        </Button>
        <p className="m-0 min-w-0 text-meta text-text-muted">
          Or start a new import below. It replaces this one.
        </p>
      </div>
    </section>
  );
}

/** Asks before a new import replaces the collector's open draft (#233); the API itself replaces without asking. Keep
 * is focused first, so Enter and Escape both keep the open import, and focus returns to `returnFocus`. */
export function ReplaceImportDialog({
  open,
  onKeep,
  onReplace,
  returnFocus,
}: {
  open: boolean;
  onKeep: () => void;
  onReplace: () => void;
  returnFocus: RefObject<HTMLElement | null>;
}) {
  return (
    <Dialog
      open={open}
      onClose={onKeep}
      title="Replace your unfinished import?"
      closeLabel="Keep your unfinished import"
      returnFocus={returnFocus}
      bodyClassName="flex flex-col gap-3"
    >
      <p className="m-0 text-body">
        Starting a new import replaces the one you haven&apos;t added yet. Its
        rows and the fixes you made to them are lost.
      </p>
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="quiet" data-autofocus="" onClick={onKeep}>
          Keep unfinished import
        </Button>
        <Button variant="danger" onClick={onReplace}>
          Replace import
        </Button>
      </div>
    </Dialog>
  );
}
