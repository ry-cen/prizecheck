import type { TradeView } from "../social_generated";
import type { ChangeOffer } from "../trades_generated";
import type { Proposal, ProposalCard } from "./proposalModel";
import { offerVersion, withOfferInventoryCaps } from "./offerInventory";
import { offerLibrary } from "./offerCopies";
export type OfferTerms = Pick<ChangeOffer, "you_give" | "you_get" | "cash">;
export type OfferPhase =
  | "loading"
  | "ready"
  | "checking"
  | "changed"
  | "read_failed"
  | "gone"
  | "sending"
  | "retry_send"
  | "sent";
export type InventorySide = "give" | "get";
export type ReadSource = "version" | InventorySide;
export type OfferRead = { id: number; source: ReadSource; version: string };
export type ReadResult =
  | { kind: "version"; offer: TradeView }
  | { kind: "inventory"; cards: readonly ProposalCard[] }
  | { kind: "not_found" | "obsolete" | "failed" | "cancelled" };
export type ReadCompletion = { read: OfferRead; result: ReadResult };
export type OfferPost = { attempt: number; key: string };
export type PostResult =
  "success" | "unknown" | "not_found" | "changed" | "refused";
export type OfferLifecycle = {
  phase: OfferPhase;
  reviewed: TradeView;
  candidate: TradeView | null;
  inventory: Record<InventorySide, readonly ProposalCard[] | null>;
  failure: "version" | "inventory" | null;
  pending: ChangeOffer | null;
  nextRead: number;
  reads: Record<number, OfferRead>;
  latestRead: Partial<Record<ReadSource, number>>;
  deferred: ReadCompletion[];
  nextPost: number;
  activePost: OfferPost | null;
};
/** Read observations cannot be confused with the outcome of an issued POST. */
export type OfferEvent =
  | { type: "read_started"; source: ReadSource; version: string }
  | ({ type: "read_completed" } & ReadCompletion)
  | { type: "review_confirmed" }
  | { type: "send_requested"; terms: OfferTerms; key: string }
  | { type: "post_completed"; post: OfferPost; result: PostResult }
  | { type: "retry" | "draft_edited" };
const EMPTY = { give: null, get: null };
export function canEditOffer(offer: TradeView) {
  return (
    offer.actions.includes("counter") || offer.actions.includes("change_offer")
  );
}
export function initialOfferLifecycle(reviewed: TradeView): OfferLifecycle {
  return {
    phase: canEditOffer(reviewed) ? "loading" : "gone",
    reviewed,
    candidate: null,
    inventory: EMPTY,
    failure: null,
    pending: null,
    nextRead: 0,
    reads: {},
    latestRead: {},
    deferred: [],
    nextPost: 0,
    activePost: null,
  };
}
export function inventoryReady(model: OfferLifecycle) {
  return model.inventory.give !== null && model.inventory.get !== null;
}
export function reviewRequired(model: OfferLifecycle) {
  return (
    model.phase === "checking" ||
    model.phase === "changed" ||
    model.phase === "gone" ||
    (model.phase === "read_failed" && model.failure === "version")
  );
}
export function canSendOffer(model: OfferLifecycle) {
  // A receipt-first exact replay does not depend on a later inventory observation.
  return (
    (model.phase === "retry_send" && model.pending !== null) ||
    (model.phase === "ready" && inventoryReady(model))
  );
}
const afterInventory = (model: OfferLifecycle): OfferPhase =>
  inventoryReady(model) ? "ready" : "loading";
const terminal = (model: OfferLifecycle) =>
  model.phase === "gone" || model.phase === "sent";
function currentRead(model: OfferLifecycle, read: OfferRead) {
  return (
    read.version === offerVersion(model.reviewed) &&
    model.latestRead[read.source] === read.id
  );
}
function observe(
  model: OfferLifecycle,
  completion: ReadCompletion
): OfferLifecycle {
  const { read, result } = completion;
  if (
    terminal(model) ||
    !currentRead(model, read) ||
    result.kind === "cancelled"
  )
    return model;
  if (read.source === "version") {
    if (result.kind === "not_found")
      return { ...model, phase: "gone", inventory: EMPTY, failure: null };
    if (result.kind !== "version")
      return { ...model, phase: "read_failed", failure: "version" };
    if (!canEditOffer(result.offer))
      return {
        ...model,
        phase: "gone",
        candidate: result.offer,
        inventory: EMPTY,
        failure: null,
      };
    if (
      !reviewRequired(model) &&
      offerVersion(result.offer) === offerVersion(model.reviewed)
    )
      return model;
    return {
      ...model,
      phase: "changed",
      candidate: result.offer,
      inventory: EMPTY,
      failure: null,
    };
  }
  if (reviewRequired(model) || model.phase === "read_failed") return model;
  if (result.kind === "obsolete" || result.kind === "not_found")
    return { ...model, phase: "checking", inventory: EMPTY, failure: null };
  if (result.kind !== "inventory")
    return { ...model, phase: "read_failed", failure: "inventory" };
  const next = {
    ...model,
    inventory: { ...model.inventory, [read.source]: result.cards },
    failure: null,
  };
  return { ...next, phase: afterInventory(next) };
}
function settledObservations(model: OfferLifecycle): OfferLifecycle {
  const observations = [...model.deferred];
  return observations
    .sort((a, b) => a.read.id - b.read.id)
    .reduce(observe, { ...model, deferred: [] });
}
/** Pure lifecycle. All background outcomes pass one authority boundary before affecting consent or commands. */
export function transitionOffer(
  model: OfferLifecycle,
  event: OfferEvent
): OfferLifecycle {
  if (event.type === "read_completed") {
    const outstanding = model.reads[event.read.id];
    if (
      !outstanding ||
      outstanding.source !== event.read.source ||
      outstanding.version !== event.read.version
    )
      return model;
    const reads = { ...model.reads };
    delete reads[event.read.id];
    const next = { ...model, reads };
    if (
      terminal(model) ||
      !currentRead(model, event.read) ||
      event.result.kind === "cancelled"
    )
      return next;
    if (model.pending) {
      // Observation only: never change a retained body, key, active attempt, phase or replay eligibility.
      return {
        ...next,
        deferred: [
          ...model.deferred.filter(
            (item) => item.read.source !== event.read.source
          ),
          { read: event.read, result: event.result },
        ],
      };
    }
    return observe(next, event);
  }
  if (terminal(model)) return model;
  switch (event.type) {
    case "read_started": {
      const read = {
        id: model.nextRead + 1,
        source: event.source,
        version: event.version,
      };
      const next = {
        ...model,
        nextRead: read.id,
        reads: { ...model.reads, [read.id]: read },
        latestRead:
          event.version === offerVersion(model.reviewed)
            ? { ...model.latestRead, [read.source]: read.id }
            : model.latestRead,
      };
      if (model.pending || event.version !== offerVersion(model.reviewed))
        return next;
      if (event.source === "version")
        return { ...next, phase: "checking", inventory: EMPTY, failure: null };
      if (reviewRequired(model) || model.phase === "read_failed") return next;
      return {
        ...next,
        phase: "loading",
        inventory: { ...model.inventory, [event.source]: null },
        failure: null,
      };
    }
    case "review_confirmed":
      if (
        !model.candidate ||
        !reviewRequired(model) ||
        !canEditOffer(model.candidate)
      )
        return model;
      return {
        ...model,
        phase: "loading",
        reviewed: model.candidate,
        candidate: null,
        inventory: EMPTY,
        failure: null,
        deferred: [],
      };
    case "send_requested": {
      if (!canSendOffer(model)) return model;
      if (
        !model.pending &&
        !(["give", "get"] as const).every((side) => {
          const available = new Map(
            offerLibrary(model.inventory[side]!, model.reviewed, side).map(
              (card) => [card.edition_id, Number(card.copies)]
            )
          );
          return (
            event.terms[side === "give" ? "you_give" : "you_get"] ?? []
          ).every(
            (line) =>
              Number(line.quantity) <= (available.get(line.edition_id) ?? 0)
          );
        })
      )
        return model;
      const pending = model.pending ?? {
        ...structuredClone(event.terms),
        offer_id: model.reviewed.offer_id,
        revision: model.reviewed.revision,
        idempotency_key: event.key,
      };
      return {
        ...model,
        phase: "sending",
        pending,
        nextPost: model.nextPost + 1,
        activePost: {
          attempt: model.nextPost + 1,
          key: pending.idempotency_key,
        },
      };
    }
    case "post_completed": {
      if (
        model.phase !== "sending" ||
        !model.pending ||
        event.post.attempt !== model.activePost?.attempt ||
        event.post.key !== model.pending.idempotency_key
      )
        return model;
      if (event.result === "unknown")
        return { ...model, phase: "retry_send", activePost: null };
      const settled = { ...model, pending: null, activePost: null };
      if (event.result === "success")
        return { ...settled, phase: "sent", deferred: [] };
      if (event.result === "not_found")
        return {
          ...settled,
          phase: "gone",
          inventory: EMPTY,
          deferred: [],
          failure: null,
        };
      if (event.result === "changed") {
        // The adapter issues a NEW post-refusal read. Older observations cannot substitute for it.
        return {
          ...settled,
          phase: "checking",
          inventory: EMPTY,
          failure: null,
          deferred: [],
        };
      }
      return settledObservations({
        ...settled,
        phase: afterInventory(settled),
      });
    }
    case "retry":
      return model.phase === "read_failed"
        ? {
            ...model,
            phase: model.failure === "version" ? "checking" : "loading",
            failure: null,
          }
        : model;
    case "draft_edited":
      if (model.phase === "sending") return model;
      return model.pending
        ? settledObservations({
            ...model,
            pending: null,
            activePost: null,
            phase: afterInventory(model),
          })
        : model;
  }
}
export function offerControls(model: OfferLifecycle) {
  return {
    review:
      reviewRequired(model) &&
      model.phase !== "gone" &&
      model.candidate !== null,
    retry:
      model.phase === "read_failed"
        ? model.failure === "version"
          ? "check"
          : "inventory"
        : model.phase === "changed"
          ? "check"
          : model.phase === "loading"
            ? "inventory"
            : model.phase === "retry_send"
              ? "send"
              : null,
    send: canSendOffer(model),
    back: true,
  } as const;
}
export function offerCaps(model: OfferLifecycle, proposal: Proposal) {
  const ready =
    inventoryReady(model) &&
    !reviewRequired(model) &&
    model.phase !== "read_failed";
  if (!ready) return { proposal, ready: false, overCap: false };
  const projected = withOfferInventoryCaps(
    proposal,
    offerLibrary(model.inventory.give!, model.reviewed, "give"),
    offerLibrary(model.inventory.get!, model.reviewed, "get")
  );
  return {
    proposal: projected,
    ready: true,
    overCap: [...projected.give, ...projected.get].some(
      (line) => line.quantity > Number(line.copies)
    ),
  };
}
