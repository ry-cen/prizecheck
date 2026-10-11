import type { DeckChecks } from "./decks_generated";

export type PublishedLiveExportProps = {
  token: string;
  version: number;
  checks: Pick<
    DeckChecks,
    "total" | "size_status" | "shortage" | "excess" | "disclaimer"
  >;
  onChanged: () => void;
};

// Ticket 13 replaces this placeholder with the Published Deck's Live export.
export function PublishedLiveExport(_props: PublishedLiveExportProps) {
  return null;
}
