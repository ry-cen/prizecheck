import { useId, useRef, useState, type ReactNode } from "react";
import type { DeckDetail } from "../decks_generated";
import type { FormatCheck } from "../format_checks_generated";
import { Button } from "../ui/Button";
import { useToast } from "../ui/Toast";
import { DeleteDeckDialog } from "./DeleteDeckDialog";
import { ExportDialog, type ExportStart } from "./ExportDialog";
import { publishBlock, usePublication } from "./publication";
import { PublishDialog } from "./PublishDialog";
import type { TargetFormat } from "./targetFormat";

type Options = {
  deckId: string;
  /** The Deck as last read, or null before the first read. */
  detail: DeckDetail | null;
  /** The Target Format's result as of today, or null while a Target Format change is in flight. */
  result: FormatCheck | null;
  /** The Target Format shown (a change in flight shows the one it asks for). */
  target: TargetFormat;
  /** Reads the Deck again. */
  read: () => void;
  /** Back to the Decks index, after a delete. */
  onAllDecks: () => void;
  /** Opens Replace list… (/decks/<id>/replace, #215). */
  onReplaceList: () => void;
};

const plural = (count: string) =>
  `${count} ${count === "1" ? "card" : "cards"}`;

/**
 * The deck builder's header actions (#181): Replace list… (#215), Export, Publish and Delete for the page header, Buy
 * missing for header row 1, and their three dialogs.
 *
 * - **Replace list…** opens the import on this Deck, to paste a new list over its Deck List.
 * - **Export** opens the export dialog on Pokémon TCG Live; **Buy missing** on TCGplayer Mass Entry with the copies
 *   not owned (disabled when every copy is owned).
 * - **Publish** is disabled, with its reason shown under the actions, while the Deck has no publication and its
 *   Target Format result isn't legal (ADR 0011). A Deck that is published shows "Published · vN" instead, always
 *   enabled, so its publication can be unlisted or revoked whatever the result; inside, Republish carries the reason.
 * - **Delete** asks for the Deck's name; a deleted Deck returns to the index with a toast.
 */
export function useDeckActions({
  deckId,
  detail,
  result,
  target,
  read,
  onAllDecks,
  onReplaceList,
}: Options) {
  const idBase = useId();
  const kit = useToast();
  const { read: publication, reload } = usePublication(deckId);
  const [exporting, setExporting] = useState<ExportStart | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const exportOpener = useRef<HTMLElement | null>(null);
  const publishButton = useRef<HTMLButtonElement | null>(null);
  const deleteButton = useRef<HTMLButtonElement | null>(null);

  const blocked = publishBlock(target, result);
  const published =
    publication.kind === "ready" && publication.status.token
      ? publication.status
      : null;
  const reasonId = `${idBase}-publish-reason`;
  // The copies Buy missing sends: the Deck's need under the Want List counting setting (#208), not `not_owned`.
  const toGet = detail ? BigInt(detail.to_get) : 0n;

  const actions: ReactNode = detail && (
    <div className="flex min-w-0 flex-col items-end gap-1 phone:w-full phone:items-start">
      <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2 phone:w-full phone:gap-1 phone:[&>button]:min-w-0 phone:[&>button]:max-w-full phone:[&>button]:whitespace-normal phone:[&>button]:wrap-anywhere phone:[&>button]:px-2">
        <Button
          variant="secondary"
          className="phone:flex-1"
          onClick={onReplaceList}
        >
          Replace list…
        </Button>
        <Button
          variant="secondary"
          className="phone:flex-1"
          onClick={(event) => {
            exportOpener.current = event.currentTarget;
            setExporting({ kind: "live", scope: "not_owned" });
          }}
        >
          Export
        </Button>
        <Button
          ref={publishButton}
          variant="primary"
          disabled={!published && blocked !== null}
          aria-describedby={!published && blocked ? reasonId : undefined}
          onClick={() => setPublishing(true)}
        >
          {published ? `Published · v${published.version}` : "Publish"}
        </Button>
        <Button
          ref={deleteButton}
          variant="quiet"
          className="!text-danger phone:flex-1"
          aria-label="Delete Deck"
          onClick={() => setDeleting(true)}
        >
          Delete
        </Button>
      </div>
      {!published && blocked && (
        <p
          id={reasonId}
          className="m-0 max-w-80 text-right text-meta text-text-muted phone:text-left"
        >
          {blocked}
        </p>
      )}
    </div>
  );

  const buyMissing: ReactNode = (
    <Button
      disabled={toGet === 0n}
      onClick={(event) => {
        exportOpener.current = event.currentTarget;
        setExporting({ kind: "mass", scope: "not_owned" });
      }}
    >
      Buy missing
    </Button>
  );

  const dialogs: ReactNode = detail && (
    <>
      <ExportDialog
        start={exporting}
        onClose={() => setExporting(null)}
        returnFocus={exportOpener}
        detail={detail}
        onStale={read}
      />
      <PublishDialog
        open={publishing}
        onClose={() => setPublishing(false)}
        returnFocus={publishButton}
        deckId={deckId}
        publication={publication}
        onReload={reload}
        blocked={blocked}
        onNotLegal={read}
      />
      <DeleteDeckDialog
        open={deleting}
        onClose={() => setDeleting(false)}
        returnFocus={deleteButton}
        deck={detail.deck}
        copies={detail.checks.total}
        onChanged={read}
        onDeleted={(deleted) => {
          setDeleting(false);
          kit.show({
            message:
              deleted.copy_count === "0"
                ? `Deleted ${detail.deck.name}.`
                : `Deleted ${detail.deck.name}. ${plural(deleted.copy_count)} moved to Unsorted.`,
          });
          onAllDecks();
        }}
      />
    </>
  );

  return { actions, buyMissing, dialogs };
}
