import { tradeCardName } from "./tradeText";
import { SocialError, type TradeView } from "../social_generated";
import { TradesError, type ChangeOffer } from "../trades_generated";
import { threadVersionChanged } from "../threads/commandChanges";
import {
  canEditOffer,
  canSendOffer,
  initialOfferLifecycle,
  reviewRequired,
  transitionOffer,
  type OfferEvent,
  type OfferLifecycle,
  type OfferTerms,
} from "./offerLifecycle";
import { tradeOutcomeUnknown } from "./tradeText";
export type { OfferTerms } from "./offerLifecycle";
/** I/O adapter only. The pure model owns consent, inventory readiness and retained commands. */
export class OfferReview {
  private model: OfferLifecycle;
  private listeners = new Set<() => void>();
  private checking: Promise<TradeView> | null = null;
  constructor(offer: TradeView) {
    this.model = initialOfferLifecycle(offer);
  }
  getSnapshot = () => this.model;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  dispatch = (event: OfferEvent) => {
    const next = transitionOffer(this.model, event);
    if (next === this.model) return;
    this.model = next;
    for (const listener of this.listeners) listener();
  };
  get reviewed() {
    return this.model.reviewed;
  }
  get candidate() {
    return this.model.candidate;
  }
  get required() {
    return reviewRequired(this.model);
  }
  get unavailable() {
    return this.model.phase === "gone";
  }
  canEdit = canEditOffer;
  refresh(read: (id: string) => Promise<TradeView>): Promise<TradeView> {
    if (this.checking) return this.checking;
    this.dispatch({ type: "check_requested" });
    this.checking = read(this.reviewed.thread_id)
      .then(
        (offer) => {
          this.dispatch({ type: "version_seen", offer });
          return offer;
        },
        (cause) => {
          this.dispatch(
            cause instanceof SocialError && cause.status === 404
              ? { type: "unavailable" }
              : { type: "read_failed", stage: "version" }
          );
          throw cause;
        }
      )
      .finally(() => {
        this.checking = null;
      });
    return this.checking;
  }
  confirm() {
    const before = this.model;
    this.dispatch({ type: "review_confirmed" });
    return this.model !== before;
  }
  async submit(
    terms: OfferTerms,
    key: string,
    post: (id: string, body: ChangeOffer) => Promise<TradeView>,
    read: (id: string) => Promise<TradeView>
  ): Promise<TradeView | null> {
    if (!canSendOffer(this.model)) return null;
    this.dispatch({ type: "send_requested", terms, key });
    const command = this.model.pending;
    if (this.model.phase !== "sending" || !command) return null;
    try {
      const next = await post(this.reviewed.thread_id, command);
      this.dispatch({ type: "send_succeeded" });
      return next;
    } catch (cause) {
      if (
        (cause instanceof TradesError || cause instanceof SocialError) &&
        cause.code === "TRADE_NOT_FOUND"
      ) {
        this.dispatch({ type: "unavailable" });
        return null;
      }
      if (
        (cause instanceof TradesError || cause instanceof SocialError) &&
        (threadVersionChanged(cause.code) || cause.code === "STEP_NOT_ALLOWED")
      ) {
        this.dispatch({ type: "offer_changed" });
        await this.refresh(read);
        return null;
      }
      this.dispatch({
        type: tradeOutcomeUnknown(cause) ? "transport_failed" : "send_refused",
      });
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
