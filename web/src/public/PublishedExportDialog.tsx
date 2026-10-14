import { useRef, type RefObject } from "react";
import { EXPORT_CONTENT } from "../decks/ExportDialog";
import { PublishedLiveExport } from "../PublishedLiveExport";
import { PublishedMassEntryExport } from "../PublishedMassEntryExport";
import type { PublicSnapshot } from "../publications_generated";
import { Dialog } from "../ui/Dialog";

export type PublishedExport = "live" | "mass";

type Props = {
  /** Which export is open, or null while closed. */
  open: PublishedExport | null;
  onClose: () => void;
  returnFocus: RefObject<HTMLElement | null>;
  token: string;
  snapshot: PublicSnapshot;
  /** A 409 or 404 answer: the page reads its snapshot again. */
  onChanged: () => void;
};

/**
 * The Published Deck's two exports (#183), each in its own dialog that prepares the export as it opens: **Copy for TCG
 * Live** (the Live text with Copy, or every blocker) and **Buy on TCGplayer** (Mass Entry for the whole list). Both
 * send only the token and the snapshot version shown; the panels' markup is shared with the deck builder's Export
 * dialog and styled by the same classes.
 *
 * Escape inside the TCGplayer confirmation closes only that confirmation, never the dialog.
 */
export function PublishedExportDialog({
  open,
  onClose,
  returnFocus,
  token,
  snapshot,
  onChanged,
}: Props) {
  // Keep the last kind so the title does not flip while the dialog closes.
  const shownRef = useRef<PublishedExport>("live");
  if (open !== null) shownRef.current = open;
  const shown = shownRef.current;
  const checks = {
    total: snapshot.total,
    size_status: snapshot.checks.size_status,
    shortage: snapshot.checks.shortage,
    excess: snapshot.checks.excess,
    disclaimer: snapshot.checks.disclaimer,
  };
  return (
    <Dialog
      open={open !== null}
      onClose={onClose}
      title={shown === "mass" ? "Buy on TCGplayer" : "Copy for TCG Live"}
      closeLabel={
        shown === "mass" ? "Close TCGplayer export" : "Close Live export"
      }
      size="wide"
      returnFocus={returnFocus}
      bodyClassName="flex flex-col gap-4"
    >
      <p className="m-0 text-meta text-text-muted wrap-anywhere">
        {snapshot.title}
      </p>
      <div
        className={EXPORT_CONTENT}
        onKeyDown={(event) => {
          // The TCGplayer confirmation's own handler closes it first; a cancelled keydown keeps the Dialog open.
          if (
            event.key === "Escape" &&
            event.target instanceof Element &&
            event.target.closest('div[role="dialog"]')
          )
            event.preventDefault();
        }}
      >
        {open === "live" && (
          <PublishedLiveExport
            token={token}
            version={snapshot.version}
            checks={checks}
            onChanged={onChanged}
            autoPrepare
          />
        )}
        {open === "mass" && (
          <PublishedMassEntryExport
            token={token}
            version={snapshot.version}
            checks={checks}
            onChanged={onChanged}
            autoPrepare
          />
        )}
      </div>
    </Dialog>
  );
}
