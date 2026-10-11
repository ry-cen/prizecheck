import React, {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { CostSection, DeckCostSummary } from "../DeckCost";
import { DeckLiveExport } from "../DeckLiveExport";
import { DeckMassEntryExport } from "../DeckMassEntryExport";
import { getDeck, type DeckDetail } from "../decks_generated";
import "./DeckHeading.css";

type ExportKind = "live" | "mass";

const EXPORT_TITLES: Record<ExportKind, string> = {
  live: "Export to Pokémon TCG Live",
  mass: "Export to TCGplayer Mass Entry",
};
const EMPTY_NOTE = "Export is unavailable because this Deck has no cards.";

type Props = {
  deckId: string;
  deckName: string;
  /** The gallery's owner revision. When it is newer than this Deck read, the Deck is read again. */
  inventoryRevision: number | null;
};

/** The open Deck's tools under the workspace heading: the existing Estimated Deck Cost summary and an
 * Export menu that opens the existing Pokémon TCG Live and TCGplayer Mass Entry panels. Cost, checks and
 * exports come from the server's complete Deck read (the Deck, cost and export endpoints), never from the
 * gallery's loaded tiles. */
export function DeckHeading({ deckId, deckName, inventoryRevision }: Props) {
  const [detail, setDetail] = useState<DeckDetail | null>(null);
  const [failed, setFailed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [panel, setPanel] = useState<ExportKind | null>(null);
  const generation = useRef(0);
  const exportButton = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  const ids = useId();
  const buttonId = `${ids}-export`;
  const menuId = `${ids}-menu`;
  const noteId = `${ids}-note`;

  // Only the newest read may settle, and a read never steps back to an older inventory revision.
  const load = useCallback(async () => {
    const id = ++generation.current;
    try {
      const next = await getDeck(deckId);
      if (id !== generation.current) return;
      setDetail((previous) =>
        previous && previous.owner_revision > next.owner_revision
          ? previous
          : next
      );
      setFailed(false);
    } catch {
      if (id === generation.current) setFailed(true);
    }
  }, [deckId]);

  useEffect(() => {
    void load();
    return () => {
      generation.current++;
    };
  }, [load]);

  // The gallery saw a newer inventory than this Deck read: read the Deck again. An equal revision changes
  // nothing, so the cost isn't requested twice.
  const readRevision = detail?.owner_revision;
  useEffect(() => {
    if (
      inventoryRevision !== null &&
      readRevision !== undefined &&
      inventoryRevision > readRevision
    )
      void load();
  }, [inventoryRevision, readRevision, load]);

  const empty = detail?.checks.total === "0";
  const canExport = detail !== null && !empty;

  const items = () =>
    Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]'
      ) ?? []
    );

  // An open menu focuses its first item; a press anywhere outside the menu and its button closes it.
  useEffect(() => {
    if (!menuOpen) return;
    items()[0]?.focus();
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !menuRef.current?.contains(target) &&
        !exportButton.current?.contains(target)
      )
        setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [menuOpen]);

  // A Deck that became empty (or a failed first read) closes the menu.
  useEffect(() => {
    if (!canExport) setMenuOpen(false);
  }, [canExport]);

  function onMenuKeyDown(event: React.KeyboardEvent) {
    const list = items();
    if (!list.length) return;
    const index = list.indexOf(document.activeElement as HTMLButtonElement);
    let next: number | null = null;
    if (event.key === "ArrowDown") next = (index + 1) % list.length;
    else if (event.key === "ArrowUp")
      next = (index - 1 + list.length) % list.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = list.length - 1;
    else if (event.key === "Escape") {
      event.preventDefault();
      setMenuOpen(false);
      exportButton.current?.focus();
      return;
    } else if (event.key === "Tab") {
      setMenuOpen(false);
      return;
    }
    if (next === null) return;
    event.preventDefault();
    list[next]?.focus();
  }

  function choose(kind: ExportKind) {
    setMenuOpen(false);
    setPanel(kind);
  }

  return (
    <div className="ws-deck-heading">
      {detail ? (
        <DeckCostSummary
          deckId={deckId}
          ownerRevision={detail.owner_revision}
          totalCopies={detail.checks.total}
          onNewerRevision={() => void load()}
          headingLevel={2}
        />
      ) : (
        !failed && (
          <CostSection settled={null} totalCopies="0" headingLevel={2} />
        )
      )}
      <div className="ws-deck-export">
        <button
          ref={exportButton}
          id={buttonId}
          type="button"
          className="ws-deck-export-button"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-controls={menuOpen ? menuId : undefined}
          aria-describedby={empty ? noteId : undefined}
          disabled={!canExport}
          onClick={() => setMenuOpen((open) => !open)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setMenuOpen(true);
            }
          }}
        >
          Export <span aria-hidden="true">▾</span>
        </button>
        {menuOpen && (
          <ul
            ref={menuRef}
            id={menuId}
            role="menu"
            aria-labelledby={buttonId}
            className="ws-deck-export-menu"
            onKeyDown={onMenuKeyDown}
          >
            <li role="none">
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                onClick={() => choose("live")}
              >
                Pokémon TCG Live
              </button>
            </li>
            <li role="none">
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                onClick={() => choose("mass")}
              >
                TCGplayer Mass Entry
              </button>
            </li>
          </ul>
        )}
        {empty && (
          <p id={noteId} className="ws-deck-export-note">
            {EMPTY_NOTE}
          </p>
        )}
      </div>
      {failed && (
        <div className="ws-deck-error" role="alert">
          <p>
            {detail
              ? "This Deck couldn't be refreshed."
              : "Deck cost and exports are temporarily unavailable."}
          </p>
          <button type="button" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}
      {panel && detail && (
        <ExportDialog
          title={EXPORT_TITLES[panel]}
          deckName={deckName}
          returnFocus={exportButton}
          onClose={() => setPanel(null)}
        >
          {panel === "live" ? (
            <DeckLiveExport
              deckId={deckId}
              ownerRevision={detail.owner_revision}
              checks={detail.checks}
            />
          ) : (
            <DeckMassEntryExport
              deckId={deckId}
              ownerRevision={detail.owner_revision}
              checks={detail.checks}
            />
          )}
        </ExportDialog>
      )}
    </div>
  );
}

/** One export panel in a native modal <dialog> (as CreateLocationDialog): the page behind is inert, Escape
 * and the backdrop close it, and focus returns to the Export button. */
function ExportDialog({
  title,
  deckName,
  returnFocus,
  onClose,
  children,
}: {
  title: string;
  deckName: string;
  returnFocus: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const pressedBackdrop = useRef(false);
  const titleId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const opener = returnFocus.current;
    if (!dialog.open) dialog.showModal();
    closeRef.current?.focus();
    return () => {
      if (dialog.open) dialog.close();
      if (opener?.isConnected && opener.getClientRects().length) {
        if (opener.disabled) {
          // A Deck that became empty disables Export: focus the Deck heading instead.
          const title = document.getElementById("ws-heading");
          if (title) {
            title.tabIndex = -1;
            title.focus();
          }
        } else opener.focus();
      }
    };
    // Opens once per mount; the opener is fixed for the dialog's life.
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="ws-export-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        // Escape: React state decides when the dialog closes.
        event.preventDefault();
        onClose();
      }}
      onClose={() => {
        // The browser can force a close; keep React state in step.
        if (!dialogRef.current?.open) onClose();
      }}
      onKeyDown={(event) => {
        // Escape inside the TCGplayer confirmation closes only that confirmation (its own handler runs first).
        // A cancelled keydown stops the browser from also closing this dialog.
        if (
          event.key === "Escape" &&
          event.target instanceof Element &&
          event.target.closest('div[role="dialog"]')
        )
          event.preventDefault();
      }}
      onPointerDown={(event) => {
        pressedBackdrop.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        // Only a press and release both on the backdrop closes; a text selection that ends outside doesn't.
        const backdrop =
          pressedBackdrop.current && event.target === event.currentTarget;
        pressedBackdrop.current = false;
        if (backdrop) onClose();
      }}
    >
      <div className="ws-export-body">
        <div className="ws-export-heading">
          <div>
            <h2 id={titleId}>{title}</h2>
            <p className="ws-export-deck">{deckName}</p>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="ws-export-close"
            aria-label="Close export"
            onClick={onClose}
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>
        <div className="ws-export-content">{children}</div>
      </div>
    </dialog>
  );
}
