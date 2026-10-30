import type {
  DeckDetail,
  DeckLoanLine,
  DeckListLine,
  ElsewhereLocation,
  LineOwnership,
} from "../decks_generated";
import type { CopyState } from "../ui/CopyTile";
import { variantLabel } from "../ui/variantLabel";

/**
 * The deck builder's Deck List as the page draws it (#176): each line with its copies' states and its group.
 * Pure: everything here comes from one Deck read (GET /api/decks/{id}), so the Published Deck (#183) can group
 * its own lines with the same rules.
 *
 * Quantities are base-10 strings on the wire and may exceed 2^53, so counts are BigInts.
 */

export type DeckView = "spread" | "stacked" | "list";

/** A line with more copies than this is drawn as one pile even in Spread, never as that many tiles. */
export const SPREAD_LIMIT = 60n;

/** One Location holding copies of a line's Edition outside this Deck. */
export type Place = {
  name: string;
  /** "storage_leaf" or "deck". */
  kind: string;
  /** Every copy of the Edition held there. */
  quantity: bigint;
  /** How the page names it: the Location's name, with "(Deck)" after another Deck's. */
  label: string;
};

/** One copy of a line: the first `here` copies are in this Deck, the next `elsewhere` owned elsewhere, the
 * rest not owned. */
export type DeckCopy = {
  /** 1-based, within the line. */
  ordinal: number;
  state: CopyState;
  /** Where an owned-elsewhere copy is (a Place label); null otherwise. */
  place: string | null;
  /** A copy lent to a Friend (#253): owned but out of the Deck, so drawn as owned elsewhere ("elsewhere", no place)
   * and read "lent out". The first copies the line misses are the lent ones. */
  lent?: boolean;
};

export type DeckLine = {
  line: DeckListLine;
  /** The Variant Descriptor in words (ui/variantLabel). */
  variant: string;
  quantity: bigint;
  here: bigint;
  elsewhere: bigint;
  missing: bigint;
  /** Locations holding the Edition outside this Deck: Storage Leaves first, then other Decks, each in the
   * server's order. Empty unless the line is short of copies and some are owned elsewhere. */
  places: Place[];
  /** One entry per copy, or null when the line has more than SPREAD_LIMIT copies. */
  copies: DeckCopy[] | null;
  /** Of `missing`, the copies lent to Friends (#253): still owned, but out of the Deck with a borrower. */
  lent: bigint;
  /** What Loans take of the line's copies, one entry per borrower: "2 reserved for Kim" (#252), copies still in
   * this Deck, then "3 lent to Sam" (#253), copies out with a Friend. */
  reservedFor: string[];
  lentTo: string[];
  /** Friends' copies in this Deck (#254), one entry per lender: "1 from Misty W.". They count in `here`. */
  borrowedFrom: string[];
  /** Every note above, in the order reserved, borrowed, lent. */
  loans: string[];
};

/** How a game sorts Deck List lines into card-type groups (ADR 0023: the game passes it in): its groups in order, each
 * with its heading, and the group a line belongs to. Pokémon's is games/pokemon/deckGroups. */
export type DeckGrouping = {
  groups: readonly { kind: string; title: string }[];
  kindOf: (line: DeckListLine) => string;
};

export type LineGroup = {
  /** Unique within the Deck List. */
  key: string;
  kind: string;
  /** The group's heading, such as "Pokémon" or "Supporters". */
  title: string;
  lines: DeckLine[];
  /** Copies across the group's lines. */
  copies: bigint;
};

export type DeckListModel = {
  lines: DeckLine[];
  groups: LineGroup[];
  /** Copies on the Deck List (the basic checks' total, summed from the lines). */
  total: string;
};

const big = (value: string | undefined) => BigInt(value ?? "0");

/** Storage Leaves first, then other Decks; the server's order (name) within each. */
export function placesOf(locations: readonly ElsewhereLocation[]): Place[] {
  const place = (location: ElsewhereLocation): Place => ({
    name: location.name,
    kind: location.kind,
    quantity: big(location.quantity),
    label: location.kind === "deck" ? `${location.name} (Deck)` : location.name,
  });
  return [
    ...locations.filter((location) => location.kind !== "deck").map(place),
    ...locations.filter((location) => location.kind === "deck").map(place),
  ];
}

/** Each copy's state and, for an owned-elsewhere copy, its Location: copies fill each Place's quantity in
 * turn, in `places` order. */
export function copiesOf(
  here: bigint,
  elsewhere: bigint,
  quantity: bigint,
  places: readonly Place[]
): DeckCopy[] {
  const copies: DeckCopy[] = [];
  let placeIndex = 0;
  let usedAtPlace = 0n;
  for (let ordinal = 1; BigInt(ordinal) <= quantity; ordinal++) {
    const index = BigInt(ordinal);
    if (index <= here) {
      copies.push({ ordinal, state: "here", place: null });
      continue;
    }
    if (index <= here + elsewhere) {
      while (
        placeIndex < places.length &&
        usedAtPlace >= places[placeIndex].quantity
      ) {
        placeIndex++;
        usedAtPlace = 0n;
      }
      const at = places[placeIndex];
      usedAtPlace++;
      copies.push({ ordinal, state: "elsewhere", place: at ? at.label : null });
      continue;
    }
    copies.push({ ordinal, state: "missing", place: null });
  }
  return copies;
}

/**
 * One line's copies. The in-this-Deck count is the line's own (every Deck List answer carries it); the ownership
 * entry comes only with a Deck read, so after an edit (#177) it can be a revision behind until the next read. Its
 * counts are therefore fitted to the line's quantity: copies owned elsewhere are the line's need beyond this Deck, up
 * to the copies the listed Locations hold, and the rest are not owned. With a current entry this is exactly the
 * server's split (deck_ownership).
 */
export function deckLine(
  line: DeckListLine,
  ownership: LineOwnership | undefined,
  loans?: DeckLoanLine
): DeckLine {
  const quantity = big(line.quantity);
  const here = big(line.in_deck);
  const places = placesOf(ownership?.locations ?? []);
  const need = quantity > here ? quantity - here : 0n;
  const outside = places.length
    ? places.reduce((total, place) => total + place.quantity, 0n)
    : big(ownership?.elsewhere);
  const elsewhere = outside < need ? outside : need;
  const missing = need - elsewhere;
  const lentOut = (loans?.lent ?? []).reduce(
    (total, label) => total + big(label.copies),
    0n
  );
  const lent = lentOut < missing ? lentOut : missing;
  const notes = loanNotes(loans);
  return {
    line,
    variant: variantLabel(line.descriptor),
    quantity,
    here,
    elsewhere,
    missing,
    places,
    copies:
      quantity <= SPREAD_LIMIT
        ? markLent(copiesOf(here, elsewhere, quantity, places), lent)
        : null,
    lent,
    ...notes,
    loans: [...notes.reservedFor, ...notes.borrowedFrom, ...notes.lentTo],
  };
}

/** Turns the first `lent` missing copies into lent ones (#253): owned elsewhere, with a Friend. */
function markLent(copies: DeckCopy[], lent: bigint): DeckCopy[] {
  let left = lent;
  return copies.map((copy) => {
    if (copy.state !== "missing" || left === 0n) return copy;
    left--;
    return { ...copy, state: "elsewhere", lent: true };
  });
}

/**
 * "2 reserved for Kim" for each borrower whose Loan holds some of the line's copies in this Deck (#252), and "3 lent to
 * Sam" for each one who has copies taken from it (#253). Lent copies are out of the Deck, so the line counts them as
 * missing, and the note says where they are. A Deck answer from before #253 has no `lent`. "1 from Misty W." for each
 * Friend whose copies the collector borrowed into this Deck (#254): they count as in this Deck, and the note says
 * whose they are. An answer from before #254 has no `borrowed`.
 */
export function loanNotes(loans: DeckLoanLine | undefined): {
  reservedFor: string[];
  lentTo: string[];
  borrowedFrom: string[];
} {
  return {
    reservedFor: (loans?.reserved ?? []).map(
      (label) => `${label.copies} reserved for ${label.name}`
    ),
    lentTo: (loans?.lent ?? []).map(
      (label) => `${label.copies} lent to ${label.name}`
    ),
    borrowedFrom: (loans?.borrowed ?? []).map(
      (label) => `${label.copies} from ${label.name}`
    ),
  };
}

const byName = (a: DeckLine, b: DeckLine) =>
  a.line.name.localeCompare(b.line.name, "en") ||
  a.line.set_name.localeCompare(b.line.set_name, "en") ||
  a.line.collector_number.localeCompare(b.line.collector_number, "en", {
    numeric: true,
  }) ||
  a.line.edition_id.localeCompare(b.line.edition_id);
/** More copies first, then by name, set, number and Edition. */
const byCopies = (a: DeckLine, b: DeckLine) =>
  a.quantity === b.quantity ? byName(a, b) : a.quantity > b.quantity ? -1 : 1;
const sum = (lines: readonly DeckLine[]) =>
  lines.reduce((total, line) => total + line.quantity, 0n);

/** The grouping's groups in its order, with most copies first, then by name, in each. Empty groups are omitted. */
export function groupLines(
  lines: readonly DeckLine[],
  grouping: DeckGrouping
): LineGroup[] {
  const groups: LineGroup[] = [];
  const members = new Map<string, DeckLine[]>();
  for (const line of lines) {
    const kind = grouping.kindOf(line.line);
    members.set(kind, [...(members.get(kind) ?? []), line]);
  }
  for (const { kind, title } of grouping.groups) {
    const group = members.get(kind);
    if (!group?.length) continue;
    groups.push({
      key: kind,
      kind,
      title,
      lines: [...group].sort(byCopies),
      copies: sum(group),
    });
  }
  return groups;
}

export function deckListModel(
  detail: DeckDetail,
  grouping: DeckGrouping
): DeckListModel {
  const ownership = new Map(
    detail.ownership.map((entry) => [entry.edition_id, entry])
  );
  const loans = new Map(
    (detail.loans ?? []).map((entry) => [entry.edition_id, entry])
  );
  const lines = detail.deck_list.lines.map((line) =>
    deckLine(line, ownership.get(line.edition_id), loans.get(line.edition_id))
  );
  return {
    lines,
    groups: groupLines(lines, grouping),
    // The basic checks' total is the sum of the lines; summing them keeps N/60 current after an edit (#177), whose
    // answer carries the lines but no checks.
    total: lines.reduce((sum, line) => sum + line.quantity, 0n).toString(),
  };
}

/** "Paldea Evolved · 185 · Reverse Holo": the Names line's second line. */
export function editionText(line: DeckLine): string {
  return `${line.line.set_name} · ${line.line.collector_number} · ${line.variant}`;
}

/** "1 in this Deck, 2 owned elsewhere, 1 lent out, 1 not owned", leaving out the states with no copies. */
export function stateWords(line: DeckLine): string {
  return [
    line.here > 0n && `${line.here} in this Deck`,
    line.elsewhere > 0n && `${line.elsewhere} owned elsewhere`,
    line.lent > 0n && `${line.lent} lent out`,
    line.missing > line.lent && `${line.missing - line.lent} not owned`,
  ]
    .filter(Boolean)
    .join(", ");
}

/** A Stacked pile's summary in parts, such as ["×4", "1↻", "1 lent", "1$"]: the copies, then those owned elsewhere, lent
 * out and not owned. Each part is drawn whole, so a narrow tile wraps between them. */
export function pileParts(line: DeckLine): string[] {
  return [
    `×${line.quantity}`,
    line.elsewhere > 0n && `${line.elsewhere}↻`,
    line.lent > 0n && `${line.lent} lent`,
    line.missing > line.lent && `${line.missing - line.lent}$`,
  ].filter((part): part is string => Boolean(part));
}

/** A Stacked pile's accessible name and hover title. */
export function pileLabel(line: DeckLine): string {
  const where = line.places.length
    ? ` (${line.places.map((place) => place.label).join(", ")})`
    : "";
  return `${line.line.name}, ${editionText(line)}: ${line.quantity} ${
    line.quantity === 1n ? "copy" : "copies"
  }, ${stateWords(line)}${line.elsewhere > 0n ? where : ""}${loanSuffix(line)}`;
}

/** "; 2 reserved for Kim" after a pile's or copy's label, or "". */
function loanSuffix(line: DeckLine): string {
  return line.loans.length ? `; ${line.loans.join(", ")}` : "";
}

const STATE_TEXT: Record<CopyState, string> = {
  here: "in this Deck",
  elsewhere: "owned elsewhere",
  missing: "not owned",
};

/** One copy's state in words: "in this Deck", "owned elsewhere, in Binder", "lent out" or "not owned". */
export function copyStateText(copy: DeckCopy): string {
  if (copy.lent) return "lent out";
  return copy.state === "elsewhere" && copy.place
    ? `${STATE_TEXT.elsewhere}, in ${copy.place}`
    : STATE_TEXT[copy.state];
}

/** A Spread tile's accessible name and hover title. */
export function copyLabel(line: DeckLine, copy: DeckCopy): string {
  return `${line.line.name}, ${editionText(line)}, copy ${copy.ordinal} of ${line.quantity}: ${copyStateText(copy)}${loanSuffix(line)}`;
}

/**
 * The price of `quantity` copies at a quote's exact `amount` (decimal text with up to six places), rounded
 * once, half-up to cents, as the server rounds Deck cost: "$12.40", or "<$0.01" for a positive sub-cent
 * total.
 */
export function lineTotal(amount: string, quantity: string): string {
  const [whole, fraction = ""] = amount.split(".");
  const micros =
    BigInt(whole) * 1_000_000n + BigInt((fraction + "000000").slice(0, 6));
  const total = micros * BigInt(quantity);
  if (total > 0n && total < 10_000n) return "<$0.01";
  const cents = (total + 5_000n) / 10_000n;
  return `$${(cents / 100n).toLocaleString("en-US")}.${(cents % 100n)
    .toString()
    .padStart(2, "0")}`;
}
