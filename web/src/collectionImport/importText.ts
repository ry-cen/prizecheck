import {
  CollectionImportError,
  type CollectionImportCard,
  type CollectionImportLeftOut,
  type CollectionImportRow,
  type CollectionImportSource,
  type CollectionImportSummary,
} from "../collection_import_generated";

/* Collection Import copy (#226, #227, #229 to #234). It never names the tracker a file came from, and shows no prices,
 * marketplace IDs, fetch times or internal reasons (AGENTS.md "UI copy"). Tracker names appear only in ExportHelp. */

export const SPLIT_LARGE =
  "This file is larger than 5 MB. Split it into two files and import each one.";
/** The largest file the start route takes: 5 MiB, the API's MAX_IMPORT_BYTES and the gateway's limit. A larger file
 * is refused before it uploads. */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
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
  IMPORT_RATE_LIMITED: "You can start 20 imports a day. Try again tomorrow.",
};

const SAVE: Record<string, string> = {
  ROWS_NEED_YOU: "Some rows still need you.",
  STALE_DRAFT:
    "This import changed in another window, so nothing was added. Check the review and try again.",
  REVIEW_CHANGED:
    "Some cards or your Locations changed, so nothing was added. Check the review and try again.",
  IMPORT_NOT_FOUND: "This import is no longer open. Choose your file again.",
  REPLAY_OUTCOME_UNAVAILABLE:
    "This import is no longer open. Choose your file again.",
  NOTHING_TO_ADD: "There are no cards to add.",
  QUANTITY_OVERFLOW: "That's more copies of one card than a Location can hold.",
};

/** A paste's refusals (#234) say "list", not "file". */
export const PASTE_LARGE =
  "This list is larger than 5 MB. Split it into two lists and import each one.";
const PASTE_START: Record<string, string> = {
  ...START,
  IMPORT_TOO_LARGE: PASTE_LARGE,
  IMPORT_TOO_MANY_ROWS:
    "This list has more than 10,000 rows. Split it into two lists and import each one.",
  IMPORT_UNREADABLE: "PrizeCheck can't read this list. Paste it as plain text.",
  IMPORT_EMPTY: "This list has no cards in it.",
};

/** What a failed upload (or paste, #234) tells the collector. The gateway's own body limit answers 413 without a
 * code. */
export function startErrorText(
  error: unknown,
  kind: "file" | "paste" = "file"
): string {
  const fallback =
    kind === "paste"
      ? "Couldn't read your list. Try again."
      : "Couldn't read your file. Try again.";
  if (!(error instanceof CollectionImportError)) return fallback;
  if (error.status === 413) return kind === "paste" ? PASTE_LARGE : SPLIT_LARGE;
  return (kind === "paste" ? PASTE_START : START)[error.code] ?? fallback;
}

/** What a failed save tells the collector. */
export function saveErrorText(error: unknown): string {
  if (!(error instanceof CollectionImportError))
    return "Couldn't add the cards. Try again.";
  return SAVE[error.code] ?? "Couldn't add the cards. Try again.";
}

/** The upload's Unfinished import note (#233): what the collector's open import holds. */
export function unfinishedText(summary: CollectionImportSummary): string {
  const needs = summary.counts.needs_you;
  const waiting =
    needs > 0
      ? `, and ${rowsText(needs)} ${needs === 1 ? "needs" : "need"} you`
      : "";
  return `You have an import you haven't added yet: ${cardsText(summary.cards_to_add)} to add${waiting}.`;
}

/** Continue import found no open import: it expired, or was saved or replaced in another window. */
export const UNFINISHED_GONE =
  "That import is no longer open. Start a new one.";

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

/** A card as the resolver lists it: "Pikachu · Fixture Promos 1". */
export function cardText(card: {
  name: string;
  set_name: string;
  collector_number: string;
}): string {
  return `${card.name} · ${card.set_name} ${card.collector_number}`;
}

/** What a pick did: the card the row is now, or why it couldn't take it. */
export function pickText(
  rowNumber: number,
  card: string,
  applied: number
): string {
  return applied > 0
    ? `Row ${rowNumber} is now ${card}.`
    : `Row ${rowNumber} can't take a card. Skip it instead.`;
}

/** Where the resolver's catalog search starts: the row's card name without its tags in brackets or a trailing
 * " - number", as matching reads it (api/app/collection_import_matcher.py card_name repeats this clean-up; change both
 * together; "Raichu GX - 20/68 (#60 Pikachu Stamped)" is "Raichu GX"). */
export function searchStart(row: CollectionImportRow): string {
  return row.source.name
    .replace(/\([^()]*\)|\[[^\]]*\]/g, " ")
    .replace(/\s+-\s+\S*[0-9]\S*\s*$/, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The resolver's line for a row whose quantity can't be read: no card can fix it, so it is skipped or fixed in the
 * file. */
export const UNREADABLE_QUANTITY =
  "PrizeCheck can't read how many copies this row has. Fix the quantity in your file and import it again, or skip this row.";

/** The candidates a resolver lists: every card the row could be except the one it already is. */
export function otherCandidates(
  row: CollectionImportRow
): CollectionImportCard[] {
  return row.candidates.filter(
    (card) => card.printing_id !== row.card?.printing_id
  );
}

const CHANGE: Record<string, string> = {
  NOT_STORAGE_LEAF: "Choose another Location to put the cards in.",
  STALE_DRAFT:
    "This import changed in another window, so nothing was changed. Check the rows and try again.",
  IMPORT_NOT_FOUND: "This import is no longer open. Choose your file again.",
  CATALOG_UNAVAILABLE:
    "Cards and finishes can't be changed right now. Try again in a few minutes.",
  INVALID_PICK: "That card isn't in the catalog any more. Search for it again.",
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

/** Why rows were left out (#231), in plain words: the API's reason codes are never shown. */
export const LEFT_OUT_LABELS: Record<
  CollectionImportLeftOut["reason"],
  string
> = {
  watchlist: "On a watchlist",
  other_game: "From other games",
  not_english: "Not in English",
  sealed: "Sealed products",
};

/** A left-out row as View lists it, from the file's own words: "Wartortle · Base Set 042/102". */
export function exampleText(source: CollectionImportSource): string {
  const where = [source.set_name, source.number].filter(Boolean).join(" ");
  return [source.name || "A row with no name", where]
    .filter(Boolean)
    .join(" · ");
}

/** The side column's note on copies already held (#232): "3 of these cards are already in your Collection. …". */
export function heldText(count: string): string {
  return count === "1"
    ? "1 of these cards is already in your Collection. Importing adds to it."
    : `${count} of these cards are already in your Collection. Importing adds to them.`;
}

/** What leaving a group out, or bringing it back, did (#232). */
export function groupText(group: string, include: boolean): string {
  return include
    ? `The rows in ${group} are back in this import.`
    : `The rows in ${group} are left out of this import.`;
}
