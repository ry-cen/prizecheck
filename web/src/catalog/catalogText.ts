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
