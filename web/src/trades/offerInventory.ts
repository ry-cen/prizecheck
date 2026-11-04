import type { TradeView } from "../social_generated";
import type { Proposal, ProposalCard } from "./proposalModel";
export type OfferVersion = Pick<
  TradeView,
  "thread_id" | "offer_id" | "revision"
>;
export function offerVersion(offer: OfferVersion | undefined) {
  return offer
    ? `${offer.thread_id}/${offer.offer_id}/${offer.revision}`
    : undefined;
}
export class OfferInventoryChanged extends Error {}
/** Bracket the availability read with the same monotonic offer identity/revision. */
export async function readOfferInventory<T>(
  offer: OfferVersion | undefined,
  read: () => Promise<T>,
  readOffer: (id: string) => Promise<OfferVersion>
) {
  const version = offerVersion(offer);
  if (offer && offerVersion(await readOffer(offer.thread_id)) !== version)
    throw new OfferInventoryChanged();
  const value = await read();
  if (offer && offerVersion(await readOffer(offer.thread_id)) !== version)
    throw new OfferInventoryChanged();
  return { value, offerVersion: version };
}
/** Hide obsolete data during the render that adopts a new offer, before effects run. */
export function currentOfferRead<
  T extends { kind: string; offerVersion?: string },
>(read: T, offer: OfferVersion | undefined): T | { kind: "loading" } {
  return read.kind === "ready" && read.offerVersion !== offerVersion(offer)
    ? { kind: "loading" }
    : read;
}
/** Exact caps, never a historical maximum. Preserve quantities, including those now over cap. */
export function withOfferInventoryCaps(
  proposal: Proposal,
  give: readonly ProposalCard[],
  get: readonly ProposalCard[]
): Proposal {
  const side = (lines: Proposal["give"], cards: readonly ProposalCard[]) => {
    const counts = new Map(cards.map((card) => [card.edition_id, card.copies]));
    return lines.map((line) => ({
      ...line,
      copies: counts.get(line.edition_id) ?? "0",
    }));
  };
  return { give: side(proposal.give, give), get: side(proposal.get, get) };
}

/** Read selected Editions independently of the library's search and visible page. */
export async function selectedOfferInventory<T extends { edition_id: string }>(
  editions: readonly string[],
  readPage: (page?: number) => Promise<{ cards: T[]; next_page: number | null }>
): Promise<T[]> {
  const remaining = new Set(editions);
  const cards: T[] = [];
  let page: number | undefined;
  while (remaining.size) {
    const result = await readPage(page);
    for (const card of result.cards) {
      if (remaining.delete(card.edition_id)) cards.push(card);
    }
    if (result.next_page === null) break;
    page = result.next_page;
  }
  return cards;
}
