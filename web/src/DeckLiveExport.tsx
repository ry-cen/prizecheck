import type { DeckChecks } from "./decks_generated";

export type DeckExportProps = {
  deckId: string;
  ownerRevision: number;
  checks: DeckChecks;
};

// Scaffolding: ticket 10 owns the implementation (renders ExportOutput).
export function DeckLiveExport(_props: DeckExportProps) {
  return null;
}
