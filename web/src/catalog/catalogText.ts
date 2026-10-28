import type {
  BrowseFormat,
  BrowseKind,
  BrowseSearch,
} from "../catalog_browse_generated";

/** The format chips, Any first (spec "Catalog": a format chip hides only not_legal cards). */
export const FORMATS: readonly { value: BrowseFormat; label: string }[] = [
  { value: "standard", label: "Standard" },
  { value: "expanded", label: "Expanded" },
  { value: "glc", label: "GLC" },
];

/** The type chips. A Trainer whose Trainer Type is unknown matches none of them. */
export const KINDS: readonly { value: BrowseKind; label: string }[] = [
  { value: "pokemon", label: "Pokémon" },
  { value: "supporter", label: "Supporter" },
  { value: "item", label: "Item" },
  { value: "tool", label: "Tool" },
  { value: "stadium", label: "Stadium" },
  { value: "energy", label: "Energy" },
];

export const FORMAT_NAMES: Record<BrowseFormat, string> = {
  standard: "Standard",
  expanded: "Expanded",
  glc: "Gym Leader Challenge",
};

/** What to type, before the first answer arrives. */
export const SEARCH_EXAMPLE =
  "Type a card name, or a set code and number such as PAL 185.";

/** The search hint: which search the server ran for the words typed (spec "Catalog": a hint names the mode). */
export function searchHint(search: BrowseSearch | null): string {
  if (!search || search.mode === "all") return SEARCH_EXAMPLE;
  if (search.mode === "set_number")
    return `Set and number: ${search.set_name} (${search.set_code}) number ${search.number}.`;
  if (search.mode === "fuzzy") return closeSpellings(search.text);
  return `Name: cards whose name contains “${search.text}”.`;
}

/** A close-spelling search (mode "fuzzy"): no card's name contains the words typed, so names spelled close to them
 * are shown. Catalog's hint and the deck builder library's status both say it. */
export function closeSpellings(text: string): string {
  return `No exact matches. Showing close spellings of “${text}”.`;
}

export const CATALOG_UNAVAILABLE =
  "Catalog unavailable until the first complete import.";
export const CATALOG_REFRESHED =
  "Catalog changed. Results refreshed from page one.";
export const COLLECTION_REFRESHED =
  "Your collection changed. Results refreshed from page one.";
export const STANDING_BUSY =
  "Card legality is being updated. Retry in a moment.";
export const BROWSE_FAILED =
  "Catalog search is temporarily unavailable. Please retry.";

// ---------------------------------------------------------------- CardPopup (#174)

/** A legality Pill's words: the Format, then its standing. */
export const STANDING_WORDS = {
  legal: "Legal",
  not_legal: "Not legal",
  unknown: "Unknown",
} as const;

/** The largest stack the popup's − N + adds in one press. */
export const MAX_ADD = 999;

export function copies(count: number | string): string {
  return `${count} ${String(count) === "1" ? "copy" : "copies"}`;
}

/** The popup's Add N result. Batch add's reply carries counts only, so the new stack shows under "Where your copies
 * are", which reads again. */
export function addedText(count: number, path: string): string {
  return `Added ${copies(count)} to ${path}.`;
}

/** The popup: an add of another Edition may have completed while this one is shown. */
export function addMayHaveCompletedFor(words: string): string {
  return `Adding ${words} may have completed. Choose it again and press Add to check safely.`;
}

/** The popup, after an earlier add that may have completed was settled instead of this press (#196). */
export function earlierAddFinishedFor(
  count: number,
  words: string,
  path: string
): string {
  return `Your earlier add finished: added ${copies(count)} of ${words} to ${path}. Press Add again for the count shown.`;
}

/** Add mode, after the same: the cards still queued were not sent. */
export function earlierBatchFinished(
  count: number | string,
  path: string,
  queuedLeft: boolean
): string {
  return `Your earlier add finished: added ${cards(count)} to ${path}.${queuedLeft ? " Press Add for the cards still queued." : ""}`;
}

const ADD_ERRORS: Record<string, string> = {
  EDITION_UNAVAILABLE: "This Edition is no longer available to add.",
  LOCATION_NOT_FOUND: "That Location is gone. Choose another.",
  QUANTITY_OVERFLOW: "That Location can't hold that many more copies.",
  INVALID_QUANTITY: "Choose between 1 and 999 copies.",
};

/** An add whose answer was lost and then could not be looked up again: it may or may not be in the collection. */
export const ADD_UNKNOWN =
  "Your earlier add may have finished. Check your collection before adding again.";

export function addFailed(code: string, retry: boolean): string {
  if (code === "REPLAY_OUTCOME_UNAVAILABLE") return ADD_UNKNOWN;
  if (retry) return "Add may have completed. Press Add again to check safely.";
  return ADD_ERRORS[code] ?? "Add failed. Please retry.";
}

// ---------------------------------------------------------------- Batch add and Add mode (#175)

/** The most different Card Editions one batch add takes (POST /api/holdings/batch). */
export const MAX_BATCH_EDITIONS = 200;

/** The Catalog page's two modes (spec "Catalog": a Browse / Add to a Location Segmented in the page header). */
export const MODES = [
  { value: "browse", label: "Browse" },
  { value: "add", label: "Add to a Location" },
] as const;
export type CatalogMode = (typeof MODES)[number]["value"];

export function cards(count: number | string): string {
  return `${count} ${String(count) === "1" ? "card" : "cards"}`;
}

/** The Add mode bar's button: "Add 5 cards", or "Add cards" with nothing queued. */
export function addAllLabel(count: number): string {
  return count > 0 ? `Add ${cards(count)}` : "Add cards";
}

export const QUEUE_HINT = "Tap + on cards, then add them together.";
export const QUEUE_FULL = `A batch holds up to ${MAX_BATCH_EDITIONS} different cards. Add these first, then queue more.`;

/** The Undo toast after a batch add, and after its Undo. */
export function batchAddedText(count: number | string, path: string): string {
  return `Added ${cards(count)} to ${path}.`;
}
export function addUndoneText(count: number | string, path: string): string {
  return `Undo removed ${cards(count)} from ${path}.`;
}

/** Why Add N cards added nothing. `card` names the Card Edition the API refused, when it named one. */
export function batchFailed(
  code: string,
  retry: boolean,
  card: string | null
): string {
  if (code === "REPLAY_OUTCOME_UNAVAILABLE") return ADD_UNKNOWN;
  if (retry)
    return "Adding may have completed. Press Add again to check safely.";
  if (code === "EDITION_UNAVAILABLE")
    return `${card ?? "A card"} is no longer available to add, so it left the queue. Nothing was added.`;
  if (code === "QUANTITY_OVERFLOW")
    return `That Location can't hold that many more copies of ${card ?? "one card"}. Nothing was added.`;
  if (code === "LOCATION_NOT_FOUND")
    return "That Location is gone. Choose another.";
  return "Adding failed. Nothing was added. Please retry.";
}

const UNDO_REFUSED: Record<string, string> = {
  UNDO_INCOMPATIBLE:
    "Undo unavailable: some of these cards have moved since, so nothing was removed.",
  UNDO_NOT_NEWEST:
    "Undo unavailable: you've changed your collection since, so nothing was removed.",
  REPLAY_OUTCOME_UNAVAILABLE:
    "Undo may already have finished. Check your collection before trying again.",
  // #252: undoing the add would leave fewer copies than open Loans promised.
  PROMISED_TO_LOAN:
    "Undo unavailable: you promised some of these copies to a Loan, so nothing was removed.",
  // Trading #268 and #270: undoing the add would leave fewer copies than open Trades promised.
  PROMISED_TO_TRADE:
    "Undo unavailable: you promised some of these copies to a Trade, so nothing was removed.",
};

/** Why the toast's Undo of a batch add did nothing. */
export function addUndoFailed(code: string, retry: boolean): string {
  if (retry) return "Undo may not have finished. Try again to check safely.";
  return UNDO_REFUSED[code] ?? "That Undo is no longer available.";
}
