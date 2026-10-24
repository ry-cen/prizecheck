import type { ConversationParty } from "../social_generated";
import { trackRecord } from "./conversationMessages";

// Collector-facing text new with trader addresses (Trading #299), approved by the owner.

/** A send, Counter or accept refused with COLLECTOR_UNAVAILABLE. */
export const SEND_UNAVAILABLE = "This collector is no longer available.";

/** The page title while a stranger's Trade List loads, fails or can't be shown, and the builder's back-link
 * label before the name is known. */
export const TRADER_LIST_TITLE = "Trade List";

export type Band = NonNullable<ConversationParty["band"]>;

/** The distance bands (Stage 2 spec "Bands"), with en dashes. */
export const BAND_LABELS: Record<Band, string> = {
  under_5: "Under 5 mi",
  "5_to_10": "5–10 mi",
  "10_to_25": "10–25 mi",
  "25_to_50": "25–50 mi",
};

/** A band's label, or null when there is no band. */
export function bandLabel(band: Band | null | undefined): string | null {
  return band ? BAND_LABELS[band] : null;
}

/** The band and the track record on one meta line ("5–10 mi · New to trading"); null when both are unknown. */
export function traderMeta(
  band: Band | null | undefined,
  completedTrades: number | null | undefined
): string | null {
  const parts = [bandLabel(band), trackRecord(completedTrades)].filter(
    (part): part is string => part !== null
  );
  return parts.length === 0 ? null : parts.join(" · ");
}
