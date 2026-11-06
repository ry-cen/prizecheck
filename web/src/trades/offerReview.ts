import { tradeCardName, tradeOutcomeUnknown } from "./tradeText";
import { SocialError, type TradeView } from "../social_generated";
import { TradesError, type ChangeOffer } from "../trades_generated";
import { threadVersionChanged } from "../threads/commandChanges";
import { OfferInventoryChanged, offerVersion } from "./offerInventory";
import type { ProposalCard } from "./proposalModel";
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
  type OfferEffect,
} from "./offerLifecycle";
export type { OfferTerms } from "./offerLifecycle";
export type OfferIO = {
  version: (id: string, signal: AbortSignal) => Promise<TradeView>;
  inventory: (
    side: InventorySide,
    offer: TradeView,
    editions: readonly string[],
    signal: AbortSignal
  ) => Promise<readonly ProposalCard[]>;
};
/** Execute exactly the effects returned by the pure lifecycle; never infer I/O from its phase. */
export class OfferReview {
  private model: OfferLifecycle;
  private listeners = new Set<() => void>();
  private io: OfferIO | null = null;
  private readVersion: ((id: string) => Promise<TradeView>) | null = null;
  private postOffer:
    ((id: string, body: ChangeOffer) => Promise<TradeView>) | null = null;
  private controllers = new Map<number, AbortController>();
  private versionFlights = new Map<number, Promise<TradeView>>();
  private postFlights = new Map<number, Promise<TradeView | null>>();
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
    const { model, effects } = transitionOffer(this.model, event);
    const changed = model !== this.model;
    this.model = model;
    if (changed) for (const listener of this.listeners) listener();
    for (const effect of effects) this.execute(effect);
  };
  connect(io: OfferIO) {
    this.io = io;
    this.dispatch({
      type: this.model.phase === "read_failed" ? "retry" : "start",
    });
    return () => {
      this.io = null;
      for (const [id, controller] of this.controllers) {
        controller.abort();
        this.completeRead(this.model.reads[id] ?? null, { kind: "cancelled" });
      }
      this.controllers.clear();
    };
  }
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
  private execute(effect: OfferEffect) {
    if (effect.kind === "cancel") {
      this.controllers.get(effect.read.id)?.abort();
      this.controllers.delete(effect.read.id);
      this.versionFlights.delete(effect.read.id);
      return;
    }
    if (effect.kind === "post") {
      const post = this.postOffer;
      if (!post) throw new Error("Offer command transport is not connected");
      const promise = Promise.resolve()
        .then(() => post(effect.thread, effect.body))
        .then(
          (offer) => {
            this.dispatch({
              type: "post_completed",
              post: effect.post,
              result: "success",
            });
            return offer;
          },
          async (cause) => {
            const api =
              cause instanceof TradesError || cause instanceof SocialError;
            const notFound = api && cause.code === "TRADE_NOT_FOUND";
            const changed =
              api &&
              (threadVersionChanged(cause.code) ||
                cause.code === "STEP_NOT_ALLOWED");
            this.dispatch({
              type: "post_completed",
              post: effect.post,
              result: notFound
                ? "not_found"
                : changed
                  ? "changed"
                  : tradeOutcomeUnknown(cause)
                    ? "unknown"
                    : "refused",
            });
            if (notFound) return null;
            if (changed) {
              const read = this.model.latestRead.version;
              if (read !== undefined) await this.versionFlights.get(read);
              return null;
            }
            throw cause;
          }
        );
      this.postFlights.set(effect.post.attempt, promise);
      // The caller awaits this promise; attach a handler immediately, including an unmount before it resumes.
      void promise.catch(() => {});
      return;
    }
    if (!this.model.reads[effect.read.id]) return;
    const io = this.io;
    const readVersion = this.readVersion;
    if (effect.read.source !== "version" && !io) return; // Unit transport may complete its registered ticket explicitly.
    if (effect.read.source === "version" && !io && !readVersion) return;
    const controller = new AbortController();
    this.controllers.set(effect.read.id, controller);
    const fail = (cause: unknown): never => {
      if (!controller.signal.aborted)
        this.completeRead(effect.read, {
          kind:
            cause instanceof OfferInventoryChanged
              ? "obsolete"
              : cause instanceof SocialError && cause.status === 404
                ? "not_found"
                : "failed",
        });
      throw cause;
    };
    let completion: Promise<unknown>;
    if (effect.read.source === "version") {
      const observed = Promise.resolve()
        .then(() =>
          io
            ? io.version(effect.offer.thread_id, controller.signal)
            : readVersion!(effect.offer.thread_id)
        )
        .then((offer) => {
          if (!controller.signal.aborted)
            this.completeRead(effect.read, { kind: "version", offer });
          return offer;
        }, fail);
      // A refresh promise means the observation has reached the model, not just the transport.
      this.versionFlights.set(effect.read.id, observed);
      completion = observed;
    } else {
      const side = effect.read.source;
      completion = Promise.resolve()
        .then(() =>
          io!.inventory(side, effect.offer, effect.editions, controller.signal)
        )
        .then((cards) => {
          if (!controller.signal.aborted)
            this.completeRead(effect.read, { kind: "inventory", cards });
        }, fail);
    }
    void completion
      .catch(() => {})
      .finally(() => {
        this.controllers.delete(effect.read.id);
        this.versionFlights.delete(effect.read.id);
      });
  }
  private beginRead(source: ReadSource, offer: TradeView) {
    const before = this.model.nextRead;
    this.dispatch({
      type: "read_requested",
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
  select(editions: readonly string[]) {
    this.dispatch({ type: "selection_changed", editions });
  }
  invalidate(offer: TradeView) {
    this.dispatch({ type: "invalidated", version: offerVersion(offer)! });
  }
  refresh(
    read: (id: string) => Promise<TradeView>,
    _force = false
  ): Promise<TradeView> {
    this.readVersion = read;
    this.dispatch({ type: "read_requested", source: "version" });
    const id = this.model.latestRead.version;
    return (
      (id === undefined ? undefined : this.versionFlights.get(id)) ??
      Promise.resolve(this.model.candidate ?? this.reviewed)
    );
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
    this.postFlights.clear();
    this.postOffer = post;
    this.readVersion = read;
    this.dispatch({ type: "send_requested", terms, key });
    return this.postFlights.get(this.model.nextPost) ?? null;
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
