import type { DeckListLine } from "../decks_generated";
import {
  deckLine,
  editionText,
  groupLines,
  lineTotal,
  type DeckLine,
  type LineGroup,
} from "../decks/deckListModel";
import type { PublishedFormatCheck } from "../format_checks_generated";
import { POKEMON_DECK_GROUPING } from "../games/pokemon/deckGroups";
import type { PublishedDeckCost } from "../prices_generated";
import type { PublicSnapshot } from "../publications_generated";

/**
 * A Published Deck snapshot as the page draws it (#183). Pure: everything comes from the public snapshot, its public
 * cost and its public format result, never from an owner's Collection.
 *
 * Each frozen row becomes a Deck List line so the deck builder's grouping (decks/deckListModel) groups it the same way:
 * Pokémon, Trainer Types and Energy, from the display facts frozen with the snapshot. Every copy is plain (all
 * "in this Deck"), because a snapshot says nothing about ownership. A line's key is the one the public routes use: the
 * row's Edition reference, or `row:<n>` (its 0-based position among the snapshot's rows) for a legacy row without one,
 * so a format issue's lines and a price's `edition_ref` find their line.
 */

/** The key the public format checks and cost use for the row at `index`. */
export function rowKey(editionRef: string | null | undefined, index: number) {
  return editionRef ?? `row:${index}`;
}

/** The snapshot's rows as plain Deck List lines, rows of one Edition merged, in snapshot order. */
export function publishedLines(snapshot: PublicSnapshot): DeckLine[] {
  const lines = new Map<string, DeckListLine>();
  let index = 0;
  for (const identity of snapshot.identities)
    for (const edition of identity.editions) {
      const key = rowKey(edition.edition_ref, index++);
      const previous = lines.get(key);
      if (previous) {
        const quantity = (
          BigInt(previous.quantity) + BigInt(edition.quantity)
        ).toString();
        lines.set(key, { ...previous, quantity, in_deck: quantity });
        continue;
      }
      lines.set(key, {
        edition_id: key,
        quantity: edition.quantity,
        in_deck: edition.quantity,
        name: edition.printing_name ?? identity.name,
        set_id: edition.set_id,
        set_name: edition.set_name,
        collector_number: edition.collector_number,
        descriptor: edition.variant,
        image_url: edition.image_url,
        card_kind: edition.card_kind ?? null,
        trainer_type: edition.trainer_type ?? null,
        evolves_from: edition.evolves_from ?? null,
        identity_id: identity.name,
        identity_name: identity.name,
        evolution_root: edition.evolution_root ?? null,
        evolution_stage: edition.evolution_stage ?? null,
      });
    }
  return [...lines.values()].map((line) => deckLine(line, undefined));
}

/** Each line's large picture address, by line key: the snapshot's own direct address (the page is anonymous, so it has
 * no art route). Rows of one Edition merge into the first. */
export function publishedLargeArt(
  snapshot: PublicSnapshot
): Map<string, string | null> {
  const found = new Map<string, string | null>();
  let index = 0;
  for (const identity of snapshot.identities)
    for (const edition of identity.editions) {
      const key = rowKey(edition.edition_ref, index++);
      if (!found.has(key)) found.set(key, edition.large_image_url ?? null);
    }
  return found;
}

/**
 * The builder's groups. A snapshot published before #183 froze no card kinds, so every line would sit under "Card
 * type unknown": it is one group, "Cards", instead.
 */
export function publishedGroups(lines: readonly DeckLine[]): LineGroup[] {
  const groups = groupLines(lines, POKEMON_DECK_GROUPING);
  if (lines.length && lines.every((line) => line.line.card_kind === null))
    return groups.map((group) => ({ ...group, key: "cards", title: "Cards" }));
  return groups;
}

/** Each frozen Edition's per-copy amount (null: no price), from a cost answer for the version shown. */
export function pricesOf(
  cost: PublishedDeckCost | null
): ReadonlyMap<string, string | null> {
  return new Map(
    (cost?.editions ?? []).map((entry) => [entry.edition_ref, entry.amount])
  );
}

/** The prices as the page holds them: null while the cost is pending, else every line's amount (or null). */
export type Prices = ReadonlyMap<string, string | null> | "unavailable" | null;

/** Shown in place of a price when the cost answer is unavailable or incomplete: never "No price", which is a fact. */
export const PRICE_UNAVAILABLE = "Price unavailable";

/** One card's price ("$1.10"), "No price", or null while the cost is pending. */
export function cardPrice(prices: Prices, key: string): string | null {
  if (!prices) return null;
  if (prices === "unavailable") return PRICE_UNAVAILABLE;
  const amount = prices.get(key);
  return amount ? lineTotal(amount, "1") : "No price";
}

/** The price of the line's copies ("$4.40" for 4 × $1.10), "No price", or null while the cost is pending. */
export function linePrice(prices: Prices, line: DeckLine): string | null {
  if (!prices) return null;
  if (prices === "unavailable") return PRICE_UNAVAILABLE;
  const amount = prices.get(line.line.edition_id);
  return amount ? lineTotal(amount, line.line.quantity) : "No price";
}

/** A Spread tile's accessible name and hover title: no ownership, the price of one card once known. */
export function tileLabel(
  line: DeckLine,
  ordinal: number,
  price: string | null
): string {
  return `${line.line.name}, ${editionText(line)}, copy ${ordinal} of ${line.quantity}${price ? `, ${price}` : ""}`;
}

/** A Stacked pile's accessible name and hover title. */
export function pileLabel(line: DeckLine, price: string | null): string {
  return `${line.line.name}, ${editionText(line)}: ${line.quantity} ${
    line.quantity === 1n ? "copy" : "copies"
  }${price ? (price.startsWith("$") ? `, ${price} each` : `, ${price}`) : ""}`;
}

export type Legality = {
  status: PublishedFormatCheck["status"];
  /** The plain reasons of the card-level issues naming the line. */
  reasons: string[];
};

/**
 * One line's standing in the Target Format, from the card-level issues that name it: not legal when any of them is,
 * unknown when any is unknown, and legal otherwise. Deck-level issues are about the whole deck, not this card.
 */
export function lineLegality(
  result: PublishedFormatCheck,
  key: string
): Legality {
  const issues = result.issues.filter(
    (issue) => issue.kind === "card" && issue.lines.includes(key)
  );
  const status = issues.some((issue) => issue.effect === "not_legal")
    ? "not_legal"
    : issues.length
      ? "unknown"
      : "legal";
  return { status, reasons: issues.map((issue) => issue.reason) };
}

/**
 * The header's cost: the total and how many copies have a price ("$1.61 · 5/6 copies priced"), from the one cost
 * answer. Staleness is never shown (spec "Published Deck cards and prices": no price age).
 */
export function costText(
  cost: PublishedDeckCost | null | "unavailable"
): string {
  if (cost === null) return "Checking prices…";
  if (cost === "unavailable") return "Price unavailable";
  const coverage = `${cost.priced_copies ?? "0"}/${cost.total_copies ?? "0"} copies priced`;
  switch (cost.status) {
    case "priced":
      return `${cost.display_amount} · ${coverage}`;
    case "empty":
      return cost.display_amount ?? "$0.00";
    case "no_quotes":
      return `No prices yet · ${coverage}`;
    default:
      return "Price unavailable";
  }
}

/** "1 card", "60 cards". */
export function cardCount(total: string): string {
  return `${total} ${total === "1" ? "card" : "cards"}`;
}
