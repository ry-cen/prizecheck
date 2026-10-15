import { useEffect, useId, useState } from "react";
import { DeckLiveExport } from "../DeckLiveExport";
import { DeckMassEntryExport } from "../DeckMassEntryExport";
import type { DeckDetail } from "../decks_generated";
import type { MassEntryScope } from "../mass_entry_generated";
import { Dialog } from "../ui/Dialog";
import { Segmented } from "../ui/Segmented";
import { OLD_BUTTONS, OLD_FIELDS, OLD_TEXT } from "../workspace/legacyContent";

export type ExportKind = "live" | "mass";
export type ExportStart = { kind: ExportKind; scope: MassEntryScope };

const KINDS = [
  { value: "live", label: "Pokémon TCG Live" },
  { value: "mass", label: "TCGplayer Mass Entry" },
] as const;

// The existing export panels' plain elements (DeckLiveExport, DeckMassEntryExport, ExportOutput), styled from here so
// their markup stays shared with the Published Deck page (moved from Collection's old Deck heading, #166), whose export
// dialogs use the same classes (#183).
export const EXPORT_CONTENT = `${OLD_BUTTONS} ${OLD_FIELDS} ${OLD_TEXT} [&_section]:flex [&_section]:min-w-0 [&_section]:flex-col [&_section]:items-stretch [&_section]:gap-3 [&_section>button]:self-start [&_section>a]:self-start [&_h3]:text-body [&_h3]:font-semibold [&_p]:text-meta [&_p]:text-text-muted [&_li]:text-meta [&_li]:text-text-muted [&_ul]:m-0 [&_ul]:list-disc [&_ul]:pl-5 [&_pre]:m-0 [&_pre]:box-border [&_pre]:block [&_pre]:max-h-[40dvh] [&_pre]:w-full [&_pre]:overflow-auto [&_pre]:rounded-control [&_pre]:border [&_pre]:border-solid [&_pre]:border-border [&_pre]:bg-bg [&_pre]:p-3 [&_pre]:text-meta [&_pre]:whitespace-pre-wrap [&_pre]:text-text [&_pre]:tabular-nums [&_pre]:wrap-anywhere [&_textarea]:m-0 [&_textarea]:box-border [&_textarea]:block [&_textarea]:max-h-[40dvh] [&_textarea]:w-full [&_textarea]:resize-y [&_textarea]:overflow-auto [&_textarea]:rounded-control [&_textarea]:border [&_textarea]:border-solid [&_textarea]:border-border [&_textarea]:bg-bg [&_textarea]:p-3 [&_textarea]:text-meta [&_textarea]:whitespace-pre-wrap [&_textarea]:text-text [&_textarea]:tabular-nums [&_textarea]:wrap-anywhere [&_[role=dialog]]:mt-3 [&_[role=dialog]]:box-border [&_[role=dialog]]:flex [&_[role=dialog]]:flex-wrap [&_[role=dialog]]:items-center [&_[role=dialog]]:gap-3 [&_[role=dialog]]:rounded-panel [&_[role=dialog]]:border [&_[role=dialog]]:border-solid [&_[role=dialog]]:border-accent-border [&_[role=dialog]]:bg-surface-raised [&_[role=dialog]]:p-4 [&_[role=dialog]_p]:basis-full phone:[&_a]:inline-flex phone:[&_a]:min-h-tap phone:[&_a]:items-center`;

const RADIO_ROW =
  "flex min-h-control cursor-pointer items-center gap-2 text-body text-text phone:min-h-tap";

type Props = {
  /** Where the dialog opens, or null while it is closed: Export opens on Live, Buy missing on Mass Entry with
   * the cards not owned. */
  start: ExportStart | null;
  onClose: () => void;
  returnFocus: React.RefObject<HTMLElement | null>;
  detail: DeckDetail;
  /** An export named a newer revision than the page drew: the page reads the Deck again. */
  onStale: () => void;
};

/**
 * The deck builder's exports (#181), in one dialog: Pokémon TCG Live (the whole Deck List) and TCGplayer Mass Entry,
 * either the copies you don't own or the whole Deck List. Export opens it on Live; Buy missing opens it on Mass Entry
 * with the copies you don't own. Both exports read the Deck List, so their checks are its own basic checks, and a
 * prepared export is discarded when the inventory or the Deck List moves on.
 *
 * Escape inside the TCGplayer confirmation closes only that confirmation, never the dialog.
 */
export function ExportDialog({
  start,
  onClose,
  returnFocus,
  detail,
  onStale,
}: Props) {
  const idBase = useId();
  const [kind, setKind] = useState<ExportKind>("live");
  const [scope, setScope] = useState<MassEntryScope>("not_owned");
  useEffect(() => {
    if (!start) return;
    setKind(start.kind);
    setScope(start.scope);
  }, [start]);

  // The copies the Deck List still needs under the Want List counting setting (#208): what the not-owned scope sends.
  const toGet = detail.to_get;
  const listChecks = detail.deck_list_checks;
  const revisions = {
    deckId: detail.deck.id,
    ownerRevision: detail.owner_revision,
    deckListRevision: detail.deck_list.revision,
    onStale,
  };

  return (
    <Dialog
      open={start !== null}
      onClose={onClose}
      title="Export"
      closeLabel="Close export"
      size="wide"
      returnFocus={returnFocus}
      bodyClassName="flex flex-col gap-4"
    >
      <p className="m-0 text-meta text-text-muted wrap-anywhere">
        {detail.deck.name}
      </p>
      <Segmented
        mode="choice"
        label="Export to"
        options={KINDS}
        value={kind}
        onChange={setKind}
      />
      {kind === "mass" && (
        <fieldset className="m-0 flex min-w-0 flex-col border-0 p-0">
          <legend className="mb-1 p-0 text-meta font-medium text-text-muted">
            Send to TCGplayer
          </legend>
          <label className={RADIO_ROW}>
            <input
              type="radio"
              name={`${idBase}-scope`}
              className="m-0 size-4 accent-accent"
              checked={scope === "not_owned"}
              onChange={() => setScope("not_owned")}
            />
            Cards you don't own ({toGet})
          </label>
          <label className={RADIO_ROW}>
            <input
              type="radio"
              name={`${idBase}-scope`}
              className="m-0 size-4 accent-accent"
              checked={scope === "deck_list"}
              onChange={() => setScope("deck_list")}
            />
            The whole Deck List ({listChecks.total})
          </label>
        </fieldset>
      )}
      <div
        className={EXPORT_CONTENT}
        onKeyDown={(event) => {
          // Escape inside the TCGplayer confirmation closes only that confirmation (its own handler runs first); a
          // cancelled keydown keeps the Dialog open.
          if (
            event.key === "Escape" &&
            event.target instanceof Element &&
            event.target.closest('div[role="dialog"]')
          )
            event.preventDefault();
        }}
      >
        {kind === "live" ? (
          <DeckLiveExport {...revisions} checks={listChecks} />
        ) : scope === "not_owned" ? (
          <DeckMassEntryExport
            key="not_owned"
            {...revisions}
            scope="not_owned"
            settingsRevision={detail.settings_revision}
            // Only the copies to buy: no size warning, and empty when every card is owned.
            checks={{
              ...listChecks,
              total: toGet,
              size_status: "complete",
              shortage: "0",
              excess: "0",
            }}
            emptyMessage="You own every card on this Deck List."
          />
        ) : (
          <DeckMassEntryExport
            key="deck_list"
            {...revisions}
            scope="deck_list"
            checks={listChecks}
          />
        )}
      </div>
    </Dialog>
  );
}
