import { CollectionImportError } from "../collection_import_generated";

/* Collection Import copy (#226, #227, #230). It never names the tracker a file came from, and shows no prices, marketplace
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

/** The save bar's line: what still needs the collector, or what the save adds, and the Finish unknown rows that
 * don't hold it up. */
export function saveStatusText(
  needsYou: number,
  ready: number,
  cards: string,
  finishUnknown: number
): string {
  const later =
    finishUnknown > 0
      ? ` ${rowsText(finishUnknown)} with finish unknown can be fixed later.`
      : "";
  if (needsYou > 0)
    return `${rowsText(needsYou)} ${needsYou === 1 ? "needs" : "need"} you. Fix or skip ${needsYou === 1 ? "it" : "them"} to continue.${later}`;
  return `Ready: ${cardsText(cards)} from ${rowsText(ready)}.${later}`;
}

/** The finishes Set finish… offers for any selection, as partial Variant Descriptors: each row takes the one of its
 * card's Editions that fits, and a row whose card has none (or several) keeps its own. */
export const BULK_FINISHES: {
  label: string;
  descriptor: Record<string, unknown>;
}[] = [
  { label: "Normal", descriptor: { type: "normal" } },
  { label: "Holo", descriptor: { type: "holo" } },
  { label: "Reverse Holo", descriptor: { type: "reverse" } },
  { label: "1st Edition", descriptor: { stamp: ["1st-edition"] } },
  { label: "Cosmos Holo", descriptor: { foil: "cosmos" } },
  { label: "Poké Ball Pattern", descriptor: { foil: "pokeball" } },
  { label: "Master Ball Pattern", descriptor: { foil: "masterball" } },
];

/** "Row 3", "Rows 3 and 6", "Rows 3, 6 and 9", or the first five and "N more". */
export function rowNumbersText(numbers: number[]): string {
  if (numbers.length === 1) return `Row ${numbers[0]}`;
  const shown = numbers.length > 5 ? numbers.slice(0, 5) : numbers.slice(0, -1);
  const last =
    numbers.length > 5
      ? `${numbers.length - 5} more`
      : `${numbers[numbers.length - 1]}`;
  return `Rows ${shown.join(", ")} and ${last}`;
}

/** What a finish change did: the rows it set, and the rows that can't take that finish. */
export function finishText(
  label: string,
  applied: number,
  notApplied: number[]
): string {
  const set = applied > 0 ? `Set ${label} on ${rowsText(applied)}.` : "";
  const kept =
    notApplied.length > 0
      ? `${rowNumbersText(notApplied)} can't be ${label}, so ${notApplied.length === 1 ? "it wasn't" : "they weren't"} changed.`
      : "";
  return [set, kept].filter(Boolean).join(" ");
}

export function skipText(applied: number, skip: boolean): string {
  return `${skip ? "Skipped" : "Restored"} ${rowsText(applied)}.`;
}

const CHANGE: Record<string, string> = {
  STALE_DRAFT:
    "This import changed in another window, so nothing was changed. Check the rows and try again.",
  IMPORT_NOT_FOUND: "This import is no longer open. Choose your file again.",
  CATALOG_UNAVAILABLE:
    "Finishes can't be set right now. Try again in a few minutes.",
};

/** What a failed change tells the collector. The gateway's own body limit answers 413 without a code. */
export function changeErrorText(error: unknown): string {
  if (error instanceof CollectionImportError) {
    if (error.status === 413)
      return "Too many rows are selected. Select fewer, or use Select all.";
    if (CHANGE[error.code]) return CHANGE[error.code];
  }
  return "Couldn't change the rows. Try again.";
}
