import { CollectionImportError } from "../collection_import_generated";

/* Collection Import copy (#226, #227). It never names the tracker a file came from, and shows no prices, marketplace
 * IDs, fetch times or internal reasons (AGENTS.md "UI copy"). Tracker names appear only in ExportHelp. */

export const SPLIT_LARGE =
  "This file is larger than 5 MB. Split it into two files and import each one.";
export const SPLIT_ROWS =
  "This file has more than 10,000 rows. Split it into two files and import each one.";

const START: Record<string, string> = {
  IMPORT_TOO_LARGE: SPLIT_LARGE,
  IMPORT_TOO_MANY_ROWS: SPLIT_ROWS,
  IMPORT_UNREADABLE:
    "PrizeCheck can't read this file. Export it again with the steps under How do I export from my tracker?",
  IMPORT_BAD_ZIP:
    "PrizeCheck can't read this file. Choose a CSV, TSV or TXT file, or a zip file holding just one of them with no password.",
  IMPORT_EMPTY: "This file has no cards in it.",
  NOT_STORAGE_LEAF: "Choose another Location to put the cards in.",
  CATALOG_UNAVAILABLE:
    "Cards can't be matched right now. Try again in a few minutes.",
};

const SAVE: Record<string, string> = {
  ROWS_NEED_YOU: "Some rows still need you.",
  STALE_DRAFT: "This import changed. Choose your file again to review it.",
  REVIEW_CHANGED:
    "Your Locations or the cards changed. Choose your file again to review it.",
  IMPORT_NOT_FOUND: "This import is no longer open. Choose your file again.",
  REPLAY_OUTCOME_UNAVAILABLE:
    "This import is no longer open. Choose your file again.",
  NOTHING_TO_ADD: "There are no cards to add.",
  QUANTITY_OVERFLOW: "That's more copies of one card than a Location can hold.",
};

/** What a failed upload tells the collector. The gateway's own body limit answers 413 without a code. */
export function startErrorText(error: unknown): string {
  if (!(error instanceof CollectionImportError))
    return "Couldn't read your file. Try again.";
  if (error.status === 413) return SPLIT_LARGE;
  return START[error.code] ?? "Couldn't read your file. Try again.";
}

/** What a failed save tells the collector. */
export function saveErrorText(error: unknown): string {
  if (!(error instanceof CollectionImportError))
    return "Couldn't add the cards. Try again.";
  return SAVE[error.code] ?? "Couldn't add the cards. Try again.";
}

/** "1 card", "9 cards"; the count is text because the API sends large counts as text. */
export function cardsText(count: string): string {
  return `${count} ${count === "1" ? "card" : "cards"}`;
}

export function rowsText(count: number): string {
  return `${count} ${count === 1 ? "row" : "rows"}`;
}

/** The save bar's line: what still needs the collector, or what the save adds. */
export function saveStatusText(
  needsYou: number,
  ready: number,
  cards: string
): string {
  if (needsYou > 0)
    return `${rowsText(needsYou)} ${needsYou === 1 ? "needs" : "need"} you. Fix ${needsYou === 1 ? "it" : "them"} in your file, then import the file again.`;
  return `Ready: ${cardsText(cards)} from ${rowsText(ready)}.`;
}
