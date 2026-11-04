import type { TradeView } from "../social_generated";
import {
  matchesSearch,
  toProposalCard,
  withReleased,
  type ProposalCard,
  type ProposalSide,
} from "./proposalModel";
type Offer = Pick<TradeView, "state" | "role" | "you_give" | "you_get">;
export function reservedOfferCards(
  offer: Offer | undefined,
  side: ProposalSide
): ProposalCard[] {
  if (!offer || offer.state === "closed") return [];
  const reserved =
    offer.state === "accepted" ||
    (side === "give" ? offer.role === "proposer" : offer.role === "recipient");
  return reserved ? offer[side === "give" ? "you_give" : "you_get"] : [];
}
export function offerCopyMap(offer: Offer | undefined, side: ProposalSide) {
  return new Map(
    reservedOfferCards(offer, side).map((card) => [
      card.edition_id,
      Number(card.copies),
    ])
  );
}
export function offerLibrary(
  cards: readonly ProposalCard[],
  offer: Offer | undefined,
  side: ProposalSide,
  query = ""
): ProposalCard[] {
  const adjusted = withReleased(cards, offerCopyMap(offer, side));
  const listed = new Set(cards.map((card) => card.edition_id));
  return [
    ...adjusted,
    ...reservedOfferCards(offer, side)
      .filter(
        (card) =>
          !listed.has(card.edition_id) && matchesSearch(card.name, query)
      )
      .map(toProposalCard),
  ];
}
