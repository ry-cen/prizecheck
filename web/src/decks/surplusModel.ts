import type { CompetitionWarning, SurplusHolding } from "../decks_generated";
import { MoveError } from "../moves_generated";
import { variantLabel } from "../ui/variantLabel";
import type { DeckLine } from "./deckListModel";

/**
 * The deck builder's surplus group and competition warning (#180), from one Deck read (GET /api/decks/{id}). Pure.
 *
 * Surplus copies are physically in the Deck but cut from its Deck List: copies beyond a line's quantity, or every copy
 * of an Edition with no line. They never count toward the Deck List. The competition warning names the other Decks
 * whose Deck Lists count the same spare copies as a line of this Deck.
 *
 * Quantities are base-10 strings on the wire and may exceed 2^53, so counts are BigInts.
 */

/** A Spread shows one tile per surplus copy up to this many; an Edition with more is drawn as one pile. */
export const SURPLUS_SPREAD_LIMIT = 60n;

/** One Edition's surplus copies in this Deck. */
export type SurplusCard = {
  editionId: string;
  name: string;
  /** "Alpha Set · 25 · Normal" */
  edition: string;
  imageUrl: string | null;
  quantity: bigint;
  /** The Deck's Holding version, the Move's expected_version. */
  version: number;
};

/** One item of the Put away Move: the manifest API's item shape, from the Deck. */
export type PutAwayItem = {
  source_id: string;
  edition_id: string;
  /** Decimal string, as the manifest API expects. */
  quantity: string;
  expected_version: number;
};

const collator = new Intl.Collator("en", { numeric: true });

/** Every surplus Edition, by name, then set, collector number and Edition id. */
export function surplusCards(rows: readonly SurplusHolding[]): SurplusCard[] {
  return [...rows]
    .sort(
      (a, b) =>
        collator.compare(a.name, b.name) ||
        collator.compare(a.set_name, b.set_name) ||
        collator.compare(a.collector_number, b.collector_number) ||
        a.edition_id.localeCompare(b.edition_id)
    )
    .map((row) => ({
      editionId: row.edition_id,
      name: row.name,
      edition: `${row.set_name} · ${row.collector_number} · ${variantLabel(row.descriptor)}`,
      imageUrl: row.image_url,
      quantity: BigInt(row.quantity),
      version: row.version,
    }));
}

/** Surplus copies across the cards. */
export function surplusTotal(cards: readonly SurplusCard[]): bigint {
  return cards.reduce((total, card) => total + card.quantity, 0n);
}

/** The Put away Move's items: every surplus copy of each card, from the Deck. */
export function putAwayItems(
  deckId: string,
  cards: readonly SurplusCard[]
): PutAwayItem[] {
  return cards.map((card) => ({
    source_id: deckId,
    edition_id: card.editionId,
    quantity: card.quantity.toString(),
    expected_version: card.version,
  }));
}

/** "1 copy", "3 copies", "25,000 copies". */
export function copiesText(count: bigint): string {
  return `${count.toLocaleString("en-US")} ${count === 1n ? "copy" : "copies"}`;
}

/** A Spread tile's accessible name and hover title. */
export function surplusCopyLabel(card: SurplusCard, ordinal: number): string {
  return `${card.name}, ${card.edition}, surplus copy ${ordinal} of ${card.quantity}: in this Deck, not on the Deck List`;
}

/** A Stacked pile's or List row's accessible name and hover title. */
export function surplusPileLabel(card: SurplusCard): string {
  return `${card.name}, ${card.edition}: ${copiesText(card.quantity)} surplus, in this Deck, not on the Deck List`;
}

/** One other Deck in a competition warning. */
export type CompetingDeckNote = {
  deckId: string;
  name: string;
  /** Copies that Deck holds for its own line: never spare. */
  inDeck: bigint;
  /** Copies that Deck counts as owned elsewhere, as this Deck does. */
  elsewhere: bigint;
};

/** One line of this Deck whose owned-elsewhere copies other Decks count too. */
export type CompetitionNote = {
  editionId: string;
  name: string;
  /** "Alpha Set · 25 · Normal", or "" when the line isn't in the read (never, in practice). */
  edition: string;
  /** Copies no Deck's line holds: loose copies and copies Decks hold beyond their lines. */
  spare: bigint;
  /** Copies every Deck listing the Edition counts as owned elsewhere, this Deck included; more than `spare`. */
  counted: bigint;
  decks: CompetingDeckNote[];
};

/** The competition warnings, by the line's name and Edition, each naming the other Decks in the server's order. */
export function competitionNotes(
  warnings: readonly CompetitionWarning[],
  lines: readonly DeckLine[]
): CompetitionNote[] {
  const byEdition = new Map(lines.map((line) => [line.line.edition_id, line]));
  return warnings
    .map((warning) => {
      const line = byEdition.get(warning.edition_id);
      return {
        editionId: warning.edition_id,
        name: line?.line.name ?? "A card",
        edition: line
          ? `${line.line.set_name} · ${line.line.collector_number} · ${line.variant}`
          : "",
        spare: BigInt(warning.spare),
        counted: BigInt(warning.counted_elsewhere),
        decks: warning.decks.map((deck) => ({
          deckId: deck.deck_id,
          name: deck.name,
          inDeck: BigInt(deck.in_deck),
          elsewhere: BigInt(deck.elsewhere),
        })),
      };
    })
    .sort(
      (a, b) =>
        collator.compare(a.name, b.name) ||
        collator.compare(a.edition, b.edition) ||
        a.editionId.localeCompare(b.editionId)
    );
}

/** "4 copies are counted as owned elsewhere, but only 3 are spare." */
export function competitionSummary(note: CompetitionNote): string {
  const counted = `${copiesText(note.counted)} ${note.counted === 1n ? "is" : "are"} counted as owned elsewhere`;
  const spare =
    note.spare === 0n
      ? "none are spare"
      : note.spare === 1n
        ? "only 1 is spare"
        : `only ${note.spare.toLocaleString("en-US")} are spare`;
  return `${counted}, but ${spare}.`;
}

/** What the other Deck does with the copies: "Deck B also counts 2 as owned elsewhere", "Deck C holds 1 for its own
 * Deck List", or both. */
export function competingDeckText(deck: CompetingDeckNote): string {
  const parts = [
    deck.elsewhere > 0n &&
      `also counts ${deck.elsewhere.toLocaleString("en-US")} as owned elsewhere`,
    deck.inDeck > 0n &&
      `holds ${deck.inDeck.toLocaleString("en-US")} for its own Deck List`,
  ].filter(Boolean);
  return `${deck.name} ${parts.length ? parts.join(" and ") : "lists this card too"}`;
}

/** How a failed Put away is reported and recovered. */
export type PutAwayFailure = {
  /** Shown in the Put away dialog. */
  text: string;
  /** The outcome is unknown (no answer or a server error): a retry reuses the same manifest and key. */
  retrySame: boolean;
  /** Read the Deck again, so the surplus and its versions are current. */
  refreshDeck: boolean;
  /** Read the Location tree again (the destination went away). */
  refreshTree: boolean;
};

/** The dialog's message for a failed Put away to `destination` (a Location path). It always says whether anything
 * moved. */
export function putAwayFailure(
  error: unknown,
  destination: string
): PutAwayFailure {
  const result = (
    text: string,
    refreshDeck = false,
    refreshTree = false
  ): PutAwayFailure => ({ text, retrySame: false, refreshDeck, refreshTree });
  if (!(error instanceof MoveError) || error.status >= 500)
    return {
      text: "Put away may not have finished. Try again to check safely: nothing moves twice.",
      retrySame: true,
      refreshDeck: false,
      refreshTree: false,
    };
  switch (error.code) {
    case "STALE_HOLDING":
    case "INSUFFICIENT_QUANTITY":
      return result(
        "These copies changed since the Deck was read, so nothing moved. The Deck has been refreshed: check the surplus and try again.",
        true
      );
    case "QUANTITY_OVERFLOW":
      return result(
        `${destination} can't hold that many copies, so nothing moved.`
      );
    case "SAME_LOCATION":
      return result(`These copies are already in ${destination}.`);
    case "LOCATION_NOT_FOUND":
      return error.detail.destination_id
        ? result(
            `${destination} can no longer hold cards, so nothing moved. Choose another Location.`,
            true,
            true
          )
        : result("This Deck can no longer hold cards, so nothing moved.", true);
    case "MOVE_MANIFEST_EXPIRED":
    case "MOVE_MANIFEST_NOT_FOUND":
      return result(
        "This Put away took too long to prepare, so nothing moved. Try again."
      );
    case "REPLAY_OUTCOME_UNAVAILABLE":
      return result(
        "Put away may have already finished. The Deck has been refreshed: check it before trying again.",
        true,
        true
      );
    default:
      return result("Put away couldn't be completed, so nothing moved.", true);
  }
}
