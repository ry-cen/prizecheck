import { tradeCardName } from "./tradeText";
import { SocialError, type TradeView } from "../social_generated";
import { TradesError, type ChangeOffer } from "../trades_generated";
import { threadVersionChanged } from "../threads/commandChanges";
export type OfferTerms = Pick<ChangeOffer, "you_give" | "you_get" | "cash">;
/** Own the reviewed identity/revision together; a fresh read alone never consents to new terms. */
export class OfferReview {
  reviewed: TradeView;
  candidate: TradeView | null = null;
  required = false;
  unavailable = false;
  constructor(offer: TradeView) {
    this.reviewed = offer;
  }
  async refresh(read: (id: string) => Promise<TradeView>) {
    this.required = true;
    this.candidate = null;
    this.unavailable = false;
    try {
      this.candidate = await read(this.reviewed.thread_id);
    } catch (cause) {
      if (cause instanceof SocialError && cause.status === 404)
        this.unavailable = true;
      throw cause;
    }
    return this.candidate;
  }
  confirm() {
    if (!this.candidate || !this.canEdit(this.candidate)) return false;
    this.reviewed = this.candidate;
    this.required = false;
    this.candidate = null;
    return true;
  }
  canEdit(offer: TradeView) {
    return (
      offer.actions.includes("counter") ||
      offer.actions.includes("change_offer")
    );
  }
  async submit(
    terms: OfferTerms,
    key: string,
    post: (id: string, body: ChangeOffer) => Promise<TradeView>,
    read: (id: string) => Promise<TradeView>
  ): Promise<TradeView | null> {
    if (this.required) return null;
    const offer = this.reviewed;
    try {
      return await post(offer.thread_id, {
        ...terms,
        offer_id: offer.offer_id,
        revision: offer.revision,
        idempotency_key: key,
      });
    } catch (cause) {
      if (
        (cause instanceof TradesError || cause instanceof SocialError) &&
        cause.code === "TRADE_NOT_FOUND"
      ) {
        this.required = true;
        this.unavailable = true;
        return null;
      }
      if (
        (cause instanceof TradesError || cause instanceof SocialError) &&
        (threadVersionChanged(cause.code) || cause.code === "STEP_NOT_ALLOWED")
      ) {
        await this.refresh(read);
        return null;
      }
      throw cause;
    }
  }
}

/** Describe changed collector terms without displaying record identities or internal reasons. */
export function offerChanges(before: TradeView, after: TradeView): string[] {
  const changes: string[] = [];
  for (const [field, label] of [
    ["you_give", "You give"],
    ["you_get", "You get"],
  ] as const) {
    const old = new Map(before[field].map((card) => [card.edition_id, card]));
    const current = new Map(
      after[field].map((card) => [card.edition_id, card])
    );
    for (const id of new Set([...old.keys(), ...current.keys()])) {
      const previous = old.get(id),
        next = current.get(id);
      if ((previous?.copies ?? "0") !== (next?.copies ?? "0"))
        changes.push(
          `${label} ${tradeCardName(next ?? previous!)}: ${previous?.copies ?? "0"} before, ${next?.copies ?? "0"} now.`
        );
    }
  }
  const cash = (value: TradeView["cash"]) =>
    value
      ? `${value.payer === "you" ? "you" : "they"} pay $${(Number(value.cents) / 100).toFixed(2)}`
      : "no cash";
  if (cash(before.cash) !== cash(after.cash))
    changes.push(`Cash: ${cash(before.cash)}; now ${cash(after.cash)}.`);
  if (before.state !== after.state)
    changes.push(
      `The Trade is now ${{ proposed: "a proposal", accepted: "agreed", closed: "closed" }[after.state]}.`
    );
  return changes.length
    ? changes
    : ["The offer was updated. Review the current terms."];
}
