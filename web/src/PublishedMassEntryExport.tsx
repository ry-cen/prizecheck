import type { DeckChecks } from "./decks_generated";

export type PublishedMassEntryExportProps = {
  token: string;
  version: number;
  checks: Pick<
    DeckChecks,
    "total" | "size_status" | "shortage" | "excess" | "disclaimer"
  >;
  onChanged: () => void;
};

// Ticket 14 replaces this placeholder with the Published Deck's Mass Entry export.
export function PublishedMassEntryExport(
  _props: PublishedMassEntryExportProps
) {
  return null;
}
