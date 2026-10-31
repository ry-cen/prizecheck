import type { PickItem, PickRow, PickSource } from "../decks_generated";

/**
 * The Pick List dialog's rows (#179), as the page draws and confirms them. Pure: everything here comes from one
 * Pick List read (GET /api/decks/{id}/pick-list).
 *
 * Each row is one card (a Deck List line with copies owned elsewhere). Its source picker offers the server's
 * suggestion, which may take copies from several Locations, and each Location that holds the card. A single
 * Location takes as many copies as the row needs, up to what that Location holds; any copies it can't cover stay
 * elsewhere for a later Gather.
 *
 * Quantities are base-10 strings on the wire and may exceed 2^53, so counts are BigInts.
 */

/** The picker's value: the server's suggestion, or one source's location_id. */
export type GatherChoice = "suggested" | string;

export const SUGGESTED: GatherChoice = "suggested";

/** Copies one source gives for a row. */
export type GatherTake = {
  source: PickSource;
  quantity: bigint;
  /** Copies another Deck would newly lack for its own Deck List line; 0 for loose storage. */
  shortBy: bigint;
};

const big = (value: string) => BigInt(value);
const min = (a: bigint, b: bigint) => (a < b ? a : b);

/** The sources the server's suggestion takes copies from. */
export function suggestedSources(row: PickRow): PickSource[] {
  return row.sources.filter((source) => source.suggested !== "0");
}

/** The picker's starting value: the suggestion when it uses several Locations, otherwise its one Location. */
export function defaultChoice(row: PickRow): GatherChoice {
  const used = suggestedSources(row);
  return used.length === 1 ? used[0].location_id : SUGGESTED;
}

/** Whether the picker offers "Suggested" as its own option (the suggestion uses more than one Location). */
export function offersSuggestion(row: PickRow): boolean {
  return suggestedSources(row).length > 1;
}

/** What each source gives for a row under a choice, leaving out sources that give nothing. */
export function takesFor(row: PickRow, choice: GatherChoice): GatherTake[] {
  if (choice === SUGGESTED)
    return suggestedSources(row).map((source) => ({
      source,
      quantity: big(source.suggested),
      shortBy: source.warning ? big(source.warning.short_by) : 0n,
    }));
  const source = row.sources.find((item) => item.location_id === choice);
  if (!source) return takesFor(row, defaultChoice(row));
  const quantity = min(big(row.elsewhere), big(source.available));
  if (quantity <= 0n) return [];
  const spare = big(source.available) - big(source.committed);
  const shortBy =
    source.kind === "deck" && quantity > spare ? quantity - spare : 0n;
  return [{ source, quantity, shortBy }];
}

/** Copies a row gathers under a choice. */
export function rowCopies(takes: readonly GatherTake[]): bigint {
  return takes.reduce((total, take) => total + take.quantity, 0n);
}

/** The confirm items for these rows, each under its choice. */
export function confirmItems(
  rows: readonly PickRow[],
  choices: ReadonlyMap<string, GatherChoice>
): PickItem[] {
  return rows.flatMap((row) =>
    takesFor(row, choices.get(row.edition_id) ?? defaultChoice(row)).map(
      (take) => ({
        source_id: take.source.location_id,
        edition_id: row.edition_id,
        quantity: take.quantity.toString(),
        expected_version: take.source.version,
      })
    )
  );
}

/** How the page names a source: its full path ("Shelf / Binder 2", since names are unique only among siblings), with
 * "(Deck)" after another Deck's. */
export function sourceLabel(source: PickSource): string {
  return source.kind === "deck" ? `${source.path} (Deck)` : source.path;
}

/** A picker option for one source: "Binder: 3 here". */
export function sourceOption(source: PickSource): string {
  return `${sourceLabel(source)}: ${source.available} here`;
}

/** The "Suggested" option: "Suggested: 6 Locations". */
export function suggestionOption(row: PickRow): string {
  return `Suggested: ${suggestedSources(row).length} Locations`;
}

/** Where a row's copies come from: "2 from Binder · 1 from Box". */
export function takesText(takes: readonly GatherTake[]): string {
  return takes
    .map((take) => `${take.quantity} from ${sourceLabel(take.source)}`)
    .join(" · ");
}

/** "1 copy" or "3 copies". */
export function copiesText(count: bigint | string): string {
  return `${count} ${count.toString() === "1" ? "copy" : "copies"}`;
}

/** "1 Location" or "6 Locations". */
export function locationsText(count: number): string {
  return `${count} ${count === 1 ? "Location" : "Locations"}`;
}
