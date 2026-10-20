import type { TradeMatchCard } from "../social_generated";
import type { TradeValueLine } from "../trades_generated";

/** A card on a proposal: the facts a line and its tile show, and the copies the library offered when it was added. */
export type ProposalCard = {
  edition_id: string;
  name: string;
  set_code: string;
  set_name: string;
  collector_number: string;
  descriptor: Record<string, unknown>;
  image_url: string | null;
  copies: string;
};

/** "get" is what the collector asks the Friend for, "give" is what they offer. */
export type ProposalSide = "get" | "give";

/** One line of a proposal. Its cap is `Number(line.copies)`. */
export type ProposalLine = ProposalCard & { quantity: number };

export type Proposal = { get: ProposalLine[]; give: ProposalLine[] };

/** A card in the library, with the want it matches when Find trades matched it. */
export type LibraryCard = { card: ProposalCard; want: TradeMatchCard | null };

export const EMPTY_PROPOSAL: Proposal = { get: [], give: [] };

/** Exactly the card facts, so extras a read carries (places, need, collector_id) never enter a line. */
export function toProposalCard(source: ProposalCard): ProposalCard {
  return {
    edition_id: source.edition_id,
    name: source.name,
    set_code: source.set_code,
    set_name: source.set_name,
    collector_number: source.collector_number,
    descriptor: source.descriptor,
    image_url: source.image_url,
    copies: source.copies,
  };
}

/** A proposal that starts with one copy of a card in You get (Ask to trade). */
export function seededProposal(card: ProposalCard): Proposal {
  return { get: [{ ...toProposalCard(card), quantity: 1 }], give: [] };
}

export function otherSide(side: ProposalSide): ProposalSide {
  return side === "get" ? "give" : "get";
}

export function quantityIn(
  proposal: Proposal,
  side: ProposalSide,
  editionId: string
): number {
  return (
    proposal[side].find((line) => line.edition_id === editionId)?.quantity ?? 0
  );
}

/** The proposal with `card` at `quantity` on `side`: clamped to the copies offered, 0 taking the line out. A card on
 * the other side is never added (a card can't be on both sides), and the proposal comes back unchanged. */
export function setQuantity(
  proposal: Proposal,
  side: ProposalSide,
  card: ProposalCard,
  quantity: number
): Proposal {
  const next = Math.max(0, Math.min(quantity, Number(card.copies)));
  if (next > 0 && quantityIn(proposal, otherSide(side), card.edition_id) > 0)
    return proposal;
  const lines = proposal[side];
  const exists = lines.some((line) => line.edition_id === card.edition_id);
  let updated: ProposalLine[];
  if (next === 0)
    updated = lines.filter((line) => line.edition_id !== card.edition_id);
  else if (exists)
    updated = lines.map((line) =>
      line.edition_id === card.edition_id
        ? { ...toProposalCard(card), quantity: next }
        : line
    );
  else updated = [...lines, { ...toProposalCard(card), quantity: next }];
  return { ...proposal, [side]: updated };
}

export function proposalCopies(proposal: Proposal): number {
  return [...proposal.get, ...proposal.give].reduce(
    (total, line) => total + line.quantity,
    0
  );
}

/** The lines as the send request writes them. */
export function requestLines(
  lines: readonly ProposalLine[]
): { edition_id: string; quantity: string }[] {
  return lines.map((line) => ({
    edition_id: line.edition_id,
    quantity: String(line.quantity),
  }));
}

/** Who pays the cash on a proposal, relative to the collector building it: "none" is no cash. */
export type CashPayer = "none" | "you" | "them";

/** The cash fields as typed: a payer and a dollar amount (text, parsed to cents at send). */
export type CashDraft = { payer: CashPayer; amount: string };

export const NO_CASH: CashDraft = { payer: "none", amount: "" };

/**
 * A typed dollar amount as whole cents in the API's decimal string ("15" is "1500", "$1,234.5" is "123450"), or null
 * for anything that isn't dollars and cents from $0.01 to $999,999.99. String and integer arithmetic only, so no
 * floating-point rounding can move a cent.
 */
export function parseCents(text: string): string | null {
  const cleaned = text.replace(/\s/g, "").replace(/^\$/, "");
  const match =
    /^(\d{1,6}|\d{1,3}(?:,\d{3})+)(?:\.(\d{0,2}))?$/.exec(cleaned) ??
    /^()\.(\d{1,2})$/.exec(cleaned);
  if (!match) return null;
  const cents =
    Number(match[1].replace(/,/g, "")) * 100 +
    Number((match[2] ?? "").padEnd(2, "0"));
  return cents >= 1 && cents <= 99_999_999 ? String(cents) : null;
}

type ValueCard = { edition_id: string; quantity: number | string };

/** The lines of both sides as the value request writes them: You give first, then You get. */
export function valueLines(
  give: readonly ValueCard[],
  get: readonly ValueCard[]
): TradeValueLine[] {
  return [
    ...give.map((line) => ({
      side: "you_give" as const,
      edition_id: line.edition_id,
      quantity: String(line.quantity),
    })),
    ...get.map((line) => ({
      side: "you_get" as const,
      edition_id: line.edition_id,
      quantity: String(line.quantity),
    })),
  ];
}

/** The letters and digits of a name or query, as the server's search compares them (accents, apostrophes, periods,
 * spaces and punctuation left out). */
export function searchKey(text: string): string {
  return text
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^ -~]|['.]/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

/** As the server's q: blank matches everything; a query with no letters or digits matches nothing. */
export function matchesSearch(name: string, q: string): boolean {
  if (q.trim() === "") return true;
  const key = searchKey(q);
  return key !== "" && searchKey(name).includes(key);
}

/** The library's cards: the matches that pass the search first, in the order given, then `rest` without any Edition
 * in `matches` (hidden by the search or not, so a matched card never shows twice). `filterRest` searches `rest` here;
 * a list the server has already searched passes false. */
export function libraryCards(
  matches: TradeMatchCard[],
  rest: ProposalCard[],
  q: string,
  filterRest: boolean
): LibraryCard[] {
  const matched = new Set(matches.map((card) => card.edition_id));
  return [
    ...matches
      .filter((card) => matchesSearch(card.name, q))
      .map((card) => ({ card, want: card })),
    ...rest
      .filter(
        (card) =>
          !matched.has(card.edition_id) &&
          (!filterRest || matchesSearch(card.name, q))
      )
      .map((card) => ({ card, want: null })),
  ];
}
