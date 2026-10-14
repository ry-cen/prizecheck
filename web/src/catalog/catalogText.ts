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
  return `Name: cards whose name starts with “${search.text}”.`;
}

/** "N Printings · English catalog from TCGdex, last pulled …" (spec "Catalog": status line). */
export function catalogLine(
  printings: number,
  lastSuccess: string | null
): string {
  const pulled = lastSuccess
    ? new Date(lastSuccess).toLocaleString()
    : "at an unknown time";
  return `${printings.toLocaleString()} ${printings === 1 ? "Printing" : "Printings"} · English catalog from TCGdex, last pulled ${pulled}`;
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

/** The art note (spec "Catalog": the art, with the note that artwork doesn't prove an Edition's finish). */
export const ART_NOTE =
  "Artwork belongs to the Printing and does not prove an Edition finish.";

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

export function addedText(count: number, path: string, stack: string): string {
  return `Added ${copies(count)} to ${path}. It now holds ${stack} of this Edition.`;
}

export function plannedText(deck: string, quantity: string): string {
  return `Planned 1 for ${deck}. Its Deck List now has ${quantity} of this Edition.`;
}

const ADD_ERRORS: Record<string, string> = {
  EDITION_UNAVAILABLE: "This Edition is no longer available to add.",
  LOCATION_NOT_FOUND: "That Location is gone. Choose another.",
  QUANTITY_OVERFLOW: "That Location can't hold that many more copies.",
  INVALID_QUANTITY: "Choose between 1 and 999 copies.",
};

export function addFailed(code: string, retry: boolean): string {
  if (retry) return "Add may have completed. Press Add again to check safely.";
  return ADD_ERRORS[code] ?? "Add failed. Please retry.";
}

const PLAN_ERRORS: Record<string, string> = {
  DECK_NOT_FOUND: "That Deck is gone. Choose another.",
  EDITION_UNAVAILABLE: "This Edition is no longer available to plan.",
  STALE_DECK_LIST: "That Deck List keeps changing. Press Plan 1 again.",
};

export function planFailed(code: string, retry: boolean): string {
  if (retry)
    return "Plan 1 may have completed. Press Plan 1 again to check safely.";
  return PLAN_ERRORS[code] ?? "Plan 1 failed. Please retry.";
}
