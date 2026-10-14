import React from "react";
import { X } from "lucide-react";
import { Button } from "../ui/Button";
import { STALE_MESSAGE } from "./useStaleCollection";

type Props = {
  /** A newer owner revision was seen than the tiles or the tree came from. */
  stale: boolean;
  /** After Reload: why the selection was cleared, or "". */
  note: string;
  /** A Move, Removal or Undo is running; Reload waits for it. */
  busy: boolean;
  onReload: () => void;
  onDismissNote: () => void;
};

/** The slim stale-collection banner above the gallery (ticket 113). Its status line stays mounted,
 * empty while idle, so screen readers announce the banner and the note when they appear. */
export function StaleBanner({
  stale,
  note,
  busy,
  onReload,
  onDismissNote,
}: Props) {
  const text = stale ? STALE_MESSAGE : note;
  return (
    // A slim strip that stays in view, below the shell's sticky header, while the gallery scrolls. Idle, it
    // draws no box and its status line is visually hidden, but still announced when filled. The message is
    // text, never colour alone.
    <div
      className={
        text
          ? "sticky top-(--layout-sticky-top) z-(--layer-sticky) mt-3 box-border flex items-center gap-3 rounded-panel border border-accent-border bg-surface-raised py-1 pr-1 pl-4 phone:pl-3"
          : "flex items-center gap-3"
      }
    >
      <p className="m-0 flex-auto text-meta empty:sr-only" role="status">
        {text}
      </p>
      {stale ? (
        <Button
          className="shrink-0"
          onClick={onReload}
          aria-disabled={busy || undefined}
        >
          Reload
        </Button>
      ) : note ? (
        <Button
          variant="quiet"
          icon={X}
          label="Dismiss note"
          className="shrink-0"
          onClick={onDismissNote}
        />
      ) : null}
    </div>
  );
}
