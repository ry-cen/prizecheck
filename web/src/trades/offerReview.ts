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
  type OfferRead,
  type InventorySide,
  type ReadSource,
  type ReadResult,
} from "./offerLifecycle";
import { tradeOutcomeUnknown } from "./tradeText";
import { offerVersion } from "./offerInventory";
export type { OfferTerms } from "./offerLifecycle";
/** I/O adapter only. The pure model owns consent, inventory readiness and retained commands. */
export class OfferReview {
  private model: OfferLifecycle;
  private listeners = new Set<() => void>();
  private checking: { read: OfferRead; promise: Promise<TradeView> } | null =
    null;
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
  private beginRead(source: ReadSource, offer: TradeView): OfferRead | null {
    const before = this.model.nextRead;
    this.dispatch({
      type: "read_started",
      source,
      version: offerVersion(offer)!,
    });
    return this.model.nextRead === before
      ? null
      : this.model.reads[this.model.nextRead];
  }
  beginInventory(side: InventorySide, offer = this.reviewed) {
    return this.beginRead(side, offer);
  }
  completeRead(read: OfferRead | null, result: ReadResult) {
    if (read) this.dispatch({ type: "read_completed", read, result });
  }
  cancelRead(read: OfferRead | null) {
    this.completeRead(read, { kind: "cancelled" });
  }
  refresh(
    read: (id: string) => Promise<TradeView>,
    force = false
  ): Promise<TradeView> {
    if (
      !force &&
      this.checking &&
      this.checking.read.version === offerVersion(this.reviewed)
    )
      return this.checking.promise;
    const context = this.beginRead("version", this.reviewed);
    if (!context) return Promise.resolve(this.model.candidate ?? this.reviewed);
    const promise = Promise.resolve()
      .then(() => read(this.reviewed.thread_id))
      .then(
        (offer) => {
          this.completeRead(context, { kind: "version", offer });
          return offer;
        },
        (cause) => {
          this.completeRead(context, {
            kind:
              cause instanceof SocialError && cause.status === 404
                ? "not_found"
                : "failed",
          });
          throw cause;
        }
      )
      .finally(() => {
        if (this.checking?.read.id === context.id) this.checking = null;
      });
    this.checking = { read: context, promise };
    return promise;
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
    const postContext = this.model.activePost;
    if (this.model.phase !== "sending" || !command || !postContext) return null;
    try {
      const next = await post(this.reviewed.thread_id, command);
      this.dispatch({
        type: "post_completed",
        post: postContext,
        result: "success",
      });
      return next;
    } catch (cause) {
      if (
        (cause instanceof TradesError || cause instanceof SocialError) &&
        cause.code === "TRADE_NOT_FOUND"
      ) {
        this.dispatch({
          type: "post_completed",
          post: postContext,
          result: "not_found",
        });
        return null;
      }
      if (
        (cause instanceof TradesError || cause instanceof SocialError) &&
        (threadVersionChanged(cause.code) || cause.code === "STEP_NOT_ALLOWED")
      ) {
        this.dispatch({
          type: "post_completed",
          post: postContext,
          result: "changed",
        });
        await this.refresh(read, true);
        return null;
      }
      this.dispatch({
        type: "post_completed",
        post: postContext,
        result: tradeOutcomeUnknown(cause) ? "unknown" : "refused",
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
