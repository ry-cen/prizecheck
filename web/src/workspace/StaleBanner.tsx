import React from "react";
import { STALE_MESSAGE } from "./useStaleCollection";
import "./StaleBanner.css";

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
    <div className={`ws-stale${text ? "" : " ws-stale-idle"}`}>
      <p className="ws-stale-text" role="status">
        {text}
      </p>
      {stale ? (
        <button
          type="button"
          className="ws-stale-reload"
          onClick={onReload}
          aria-disabled={busy || undefined}
        >
          Reload
        </button>
      ) : note ? (
        <button
          type="button"
          className="ws-stale-dismiss"
          aria-label="Dismiss note"
          onClick={onDismissNote}
        >
          <span aria-hidden="true">✕</span>
        </button>
      ) : null}
    </div>
  );
}
