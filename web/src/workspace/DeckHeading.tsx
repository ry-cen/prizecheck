import React, {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { ChevronDown, X } from "lucide-react";
import { CostSection, DeckCostSummary } from "../DeckCost";
import { DeckLiveExport } from "../DeckLiveExport";
import { DeckMassEntryExport } from "../DeckMassEntryExport";
import { getDeck, type DeckDetail } from "../decks_generated";
import { Button } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { OLD_BUTTONS, OLD_FIELDS, OLD_TEXT } from "./legacyContent";

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
  /** False while the app shell shows another page: an open menu or export panel closes, so no modal stays
   * over the page now shown (#166). */
  active: boolean;
};

// The existing Estimated Deck Cost section (DeckCost.tsx), styled from here so its markup stays unchanged.
const COST =
  "min-w-0 flex-[1_1_320px] text-meta text-text-muted tabular-nums [&>section]:flex [&>section]:flex-col [&>section]:gap-1 [&_h2]:m-0 [&_h2]:text-micro [&_h2]:font-semibold [&_h2]:tracking-[1.7px] [&_h2]:text-text-muted [&_h2]:uppercase [&_p]:m-0 [&_p:first-of-type]:text-body [&_p:first-of-type]:text-text [&_strong]:font-semibold [&_strong]:text-accent";
// The existing export panels' plain elements (DeckLiveExport, DeckMassEntryExport, ExportOutput).
const EXPORT_CONTENT = `${OLD_BUTTONS} ${OLD_FIELDS} ${OLD_TEXT} [&_section]:flex [&_section]:min-w-0 [&_section]:flex-col [&_section]:items-stretch [&_section]:gap-3 [&_section>button]:self-start [&_section>a]:self-start [&_h3]:text-body [&_h3]:font-semibold [&_p]:text-meta [&_p]:text-text-muted [&_li]:text-meta [&_li]:text-text-muted [&_ul]:m-0 [&_ul]:pl-5 [&_pre]:m-0 [&_pre]:box-border [&_pre]:block [&_pre]:max-h-[40dvh] [&_pre]:w-full [&_pre]:overflow-auto [&_pre]:rounded-control [&_pre]:border [&_pre]:border-solid [&_pre]:border-border [&_pre]:bg-bg [&_pre]:p-3 [&_pre]:text-meta [&_pre]:whitespace-pre-wrap [&_pre]:text-text [&_pre]:tabular-nums [&_pre]:wrap-anywhere [&_textarea]:m-0 [&_textarea]:box-border [&_textarea]:block [&_textarea]:max-h-[40dvh] [&_textarea]:w-full [&_textarea]:resize-y [&_textarea]:overflow-auto [&_textarea]:rounded-control [&_textarea]:border [&_textarea]:border-solid [&_textarea]:border-border [&_textarea]:bg-bg [&_textarea]:p-3 [&_textarea]:text-meta [&_textarea]:whitespace-pre-wrap [&_textarea]:text-text [&_textarea]:tabular-nums [&_textarea]:wrap-anywhere [&_[role=dialog]]:mt-3 [&_[role=dialog]]:box-border [&_[role=dialog]]:flex [&_[role=dialog]]:flex-wrap [&_[role=dialog]]:items-center [&_[role=dialog]]:gap-3 [&_[role=dialog]]:rounded-panel [&_[role=dialog]]:border [&_[role=dialog]]:border-solid [&_[role=dialog]]:border-accent-border [&_[role=dialog]]:bg-surface-raised [&_[role=dialog]]:p-4 [&_[role=dialog]_p]:basis-full phone:[&_a]:inline-flex phone:[&_a]:min-h-tap phone:[&_a]:items-center`;
const MENU_ITEM =
  "m-0 box-border flex min-h-control w-full cursor-pointer items-center rounded-control border-0 bg-transparent px-3 text-left font-sans text-control text-text hover:bg-surface-selected focus-visible:bg-surface-selected phone:min-h-tap";

/** The open Deck's tools under the workspace heading: the existing Estimated Deck Cost summary and an
 * Export menu that opens the existing Pokémon TCG Live and TCGplayer Mass Entry panels. Cost, checks and
 * exports come from the server's complete Deck read (the Deck, cost and export endpoints), never from the
 * gallery's loaded tiles. */
export function DeckHeading({
  deckId,
  deckName,
  inventoryRevision,
  active,
}: Props) {
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

  // Leaving Collection closes the menu and the export panel (Collection stays mounted, hidden).
  useEffect(() => {
    if (active) return;
    setMenuOpen(false);
    setPanel(null);
  }, [active]);

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
    <div className="mb-5 box-border flex flex-wrap items-start justify-between gap-x-6 gap-y-3 rounded-panel border border-border bg-surface p-4">
      <div className={COST}>
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
      </div>
      <div className="relative flex max-w-full flex-none flex-col items-end gap-2 phone:items-start">
        <Button
          ref={exportButton}
          id={buttonId}
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
          Export <Icon icon={ChevronDown} size={14} />
        </Button>
        {menuOpen && (
          <ul
            ref={menuRef}
            id={menuId}
            role="menu"
            aria-labelledby={buttonId}
            // Only shown while the Deck has cards, so the column is exactly the button's height.
            className="absolute top-[calc(100%+var(--space-1))] right-0 z-(--layer-panel) m-0 box-border min-w-55 list-none rounded-panel border border-border-strong bg-surface-raised p-1 phone:right-auto phone:left-0"
            onKeyDown={onMenuKeyDown}
          >
            <li role="none">
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                className={MENU_ITEM}
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
                className={MENU_ITEM}
                onClick={() => choose("mass")}
              >
                TCGplayer Mass Entry
              </button>
            </li>
          </ul>
        )}
        {empty && (
          <p
            id={noteId}
            className="m-0 max-w-65 text-right text-meta text-text-muted phone:text-left"
          >
            {EMPTY_NOTE}
          </p>
        )}
      </div>
      {failed && (
        <div
          className="flex flex-[1_1_100%] items-center gap-3 text-meta text-danger"
          role="alert"
        >
          <p className="m-0">
            {detail
              ? "This Deck couldn't be refreshed."
              : "Deck cost and exports are temporarily unavailable."}
          </p>
          <Button onClick={() => void load()}>Retry</Button>
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

/** One export panel in a native modal <dialog>: the page behind is inert, Escape and the backdrop close it,
 * and focus returns to the Export button. It stays hand-rolled rather than the kit Dialog because Escape
 * inside its TCGplayer confirmation must close only the confirmation; #181 replaces it with the Decks page's
 * exports. */
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
      // A centred panel on desktop, the whole screen on a phone. Every property the browser styles a
      // dialog with is set here (no Preflight).
      className="m-auto box-border h-fit max-h-[85dvh] w-[min(640px,calc(100vw-var(--space-8)))] max-w-none overflow-auto rounded-dialog border border-solid border-border-strong bg-surface p-0 font-sans text-body leading-(--line-height) text-text backdrop:bg-scrim phone:m-0 phone:h-full phone:max-h-none phone:w-full phone:rounded-none phone:border-0"
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
      <div className="flex flex-col gap-4 p-6 phone:p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id={titleId} className="m-0 text-heading font-[550]">
              {title}
            </h2>
            <p className="m-0 text-meta text-text-muted wrap-anywhere">
              {deckName}
            </p>
          </div>
          <Button
            ref={closeRef}
            variant="quiet"
            icon={X}
            label="Close export"
            className="shrink-0"
            onClick={onClose}
          />
        </div>
        <div className={EXPORT_CONTENT}>{children}</div>
      </div>
    </dialog>
  );
}
