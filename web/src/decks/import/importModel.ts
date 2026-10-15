import type {
  ImportEdition,
  ImportFix,
  ImportPart,
  ImportReview,
  ReviewLine,
} from "../../decks_generated";
import { variantLabel } from "../../ui/variantLabel";

/**
 * Decklist Import's pure helpers (#212): which lines need the collector, the filter chips, the sections, the words a
 * line shows, and the fixes the review is posted with. The server reads the paste (api/app/decklist_text.py); nothing
 * here parses text.
 */

/** The most characters a paste may have: the API's IMPORT_TOO_LONG limit, counted in code points as Python counts. */
export const MAX_PASTE_CHARACTERS = 20_000;

export type Filter = "all" | "needs" | "changed" | "dropped";
export const FILTERS: readonly { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "needs", label: "Needs you" },
  { value: "changed", label: "Changed" },
  { value: "dropped", label: "Dropped" },
];

/** A collector's choice for one line: a card (any Edition by the rule) or one Card Edition. */
export type Pick = { printing_id: string } | { edition_id: string };

const NEEDS_YOU: readonly ReviewLine["status"][] = [
  "ambiguous",
  "not_found",
  "unreadable",
];

export const needsYou = (line: ReviewLine) => NEEDS_YOU.includes(line.status);

/** Lines the collector changed or the import substituted: a picked card, a chosen Edition, and (tickets #213 and #214)
 * a name or Basic Energy match and owned copies. */
export const changed = (line: ReviewLine) =>
  line.status === "picked" ||
  line.status === "by_name" ||
  line.status === "energy" ||
  line.parts.some(
    (part) => part.chosen_by === "collector" || part.source !== "new"
  );

export function keeps(filter: Filter, line: ReviewLine): boolean {
  if (filter === "needs") return needsYou(line);
  if (filter === "changed") return changed(line);
  if (filter === "dropped") return line.status === "dropped";
  return true;
}

export function filterCount(filter: Filter, review: ImportReview): number {
  return review.lines.filter((line) => keeps(filter, line)).length;
}

export type SectionKey = "pokemon" | "trainer" | "energy" | "none";
const SECTION_LABELS: Record<SectionKey, string> = {
  pokemon: "Pokémon",
  trainer: "Trainer",
  energy: "Energy",
  none: "No section",
};

/** The sections in a fixed order, each with its lines in paste order and its card total (lines not dropped, worked
 * out from the lines, never from a header). Sections with no line are left out. */
export function sectionsOf(
  lines: ReviewLine[]
): { key: SectionKey; label: string; cards: number; lines: ReviewLine[] }[] {
  return (["pokemon", "trainer", "energy", "none"] as const)
    .map((key) => {
      const inSection = lines.filter(
        (line) => (line.section ?? "none") === key
      );
      const cards = inSection
        .filter((line) => line.status !== "dropped")
        .reduce((sum, line) => sum + Number(line.quantity), 0);
      return { key, label: SECTION_LABELS[key], cards, lines: inSection };
    })
    .filter((section) => section.lines.length > 0);
}

export const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

/** The name a line shows: the card it resolved to, else the name pasted. */
export const lineName = (line: ReviewLine) => line.printing?.name ?? line.name;

/** The pill beside a line's name, or null for a plain match. */
export function statusText(line: ReviewLine): string | null {
  switch (line.status) {
    case "picked":
      return "Picked";
    case "by_name":
      return "Matched by name";
    case "energy":
      return "Basic Energy";
    case "ambiguous":
      return "Pick one";
    case "not_found":
      return "Not found";
    case "unreadable":
      return "Can't read";
    case "dropped":
      return "Dropped";
    default:
      return null;
  }
}

/** Why a line needs the collector, or what they did to it. */
export function noteText(line: ReviewLine): string | null {
  const pasted = [line.set_code, line.number].filter(Boolean).join(" ");
  switch (line.status) {
    case "not_found":
      return `${[line.name, pasted].filter(Boolean).join(" ")} isn't in the catalog yet.`;
    case "unreadable":
      return "This line doesn't end with a set code and number.";
    case "ambiguous":
      return `${pasted} matches ${plural(line.candidates.length, "card")}: pick the one on your list.`;
    case "picked":
      return line.printing
        ? `You picked ${line.printing.set_code} ${line.printing.collector_number}.`
        : null;
    default:
      return null;
  }
}

export const editionOf = (line: ReviewLine, editionId: string) =>
  line.editions.find((edition) => edition.edition_id === editionId);

/** An Edition as the chooser names it: "Reverse Holo · $0.43" or "Normal · no price". A quote over 48 hours old says
 * so: "Reverse Holo · $0.43 · stale (price over 48 hours old)". */
export const editionText = (edition: ImportEdition) =>
  `${variantLabel(edition.descriptor)} · ${edition.display_price ?? "no price"}${
    edition.display_price && edition.stale ? STALE : ""
  }`;

const STALE = " · stale (price over 48 hours old)";

const HOW: Record<NonNullable<ImportPart["chosen_by"]>, string> = {
  cheapest_price: "cheapest priced",
  catalog_order: "no Edition priced",
  collector: "your choice",
};

/** One Deck List line a pasted line becomes: "4 MEG 119 · Reverse Holo · your choice · no price". A Normal Edition's
 * variant is left out ("3 PAL 185 · cheapest priced · $0.35 each"). */
export function partText(line: ReviewLine, part: ImportPart): string {
  const edition = editionOf(line, part.edition_id);
  const variant = edition ? variantLabel(edition.descriptor) : null;
  const where = line.printing
    ? `${line.printing.set_code} ${line.printing.collector_number}`
    : "";
  const words = [`${part.quantity} ${where}`.trim()];
  if (variant && variant !== "Normal") words.push(variant);
  if (part.chosen_by) words.push(HOW[part.chosen_by]);
  if (part.chosen_by !== "catalog_order")
    words.push(
      edition?.display_price
        ? `${edition.display_price} each${edition.stale ? STALE : ""}`
        : "no price"
    );
  return words.join(" · ");
}

/** The fixes the review is posted with, in line order: a dropped line sends only its drop, so Restore brings back the
 * card it was picked as. */
export function fixesFor(
  picks: ReadonlyMap<number, Pick>,
  drops: ReadonlySet<number>
): ImportFix[] {
  const lines = [...new Set([...picks.keys(), ...drops])].sort((a, b) => a - b);
  return lines.map((line) =>
    drops.has(line) ? { line, drop: true } : { line, ...picks.get(line)! }
  );
}

/** Characters as the API counts them (code points), so an emoji counts once. */
export const characters = (text: string) => Array.from(text).length;

/** What the collector reads when a review request fails, by the API's error code (or the gateway's 413). */
export function reviewErrorText(status: number, code: string): string {
  if (status === 413 || code === "IMPORT_TOO_LONG")
    return "This paste is over 20,000 characters. Paste one decklist at a time.";
  if (code === "IMPORT_TOO_MANY_LINES")
    return "This paste has more than 200 card lines, more than a Deck List can hold.";
  if (
    code === "PRINTING_UNAVAILABLE" ||
    code === "EDITION_UNAVAILABLE" ||
    code === "INVALID_FIX"
  )
    return "That card can't be used any more. Search again.";
  if (code === "PRICES_UNAVAILABLE")
    return "Prices couldn't be read just now. Try again.";
  return "The list couldn't be checked. Try again.";
}

/** True when a failed request was the collector's last fix, which the page takes back. */
export const fixRefused = (code: string) =>
  code === "PRINTING_UNAVAILABLE" ||
  code === "EDITION_UNAVAILABLE" ||
  code === "INVALID_FIX";
