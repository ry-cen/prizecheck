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
type Side = "give" | "get";
export type OfferLifecycle = {
  phase: OfferPhase;
  reviewed: TradeView;
  candidate: TradeView | null;
  inventory: Record<Side, readonly ProposalCard[] | null>;
  failure: "version" | "inventory" | null;
  pending: ChangeOffer | null;
};
export type OfferEvent =
  | { type: "check_requested" }
  | { type: "version_seen"; offer: TradeView }
  | { type: "inventory_requested"; version: string; side: Side }
  | {
      type: "inventory_received";
      version: string;
      side: Side;
      cards: readonly ProposalCard[];
    }
  | { type: "inventory_obsolete"; version: string }
  | { type: "review_confirmed" }
  | { type: "read_failed"; stage: "version" | "inventory" }
  | { type: "unavailable" }
  | { type: "send_requested"; terms: OfferTerms; key: string }
  | { type: "offer_changed" }
  | { type: "transport_failed" }
  | { type: "send_refused" }
  | { type: "send_succeeded" }
  | { type: "retry" }
  | { type: "draft_edited" };
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
  return (
    (model.phase === "ready" || model.phase === "retry_send") &&
    inventoryReady(model)
  );
}
const afterInventory = (model: OfferLifecycle): OfferPhase =>
  inventoryReady(model) ? "ready" : "loading";
/** All offer consent, cap readiness and retry-key decisions live in this pure transition. */
export function transitionOffer(
  model: OfferLifecycle,
  event: OfferEvent
): OfferLifecycle {
  if (model.phase === "gone" || model.phase === "sent") return model;
  // Background reads cannot replace an in-flight or unknown command's body/key.
  if (
    (model.phase === "sending" || model.phase === "retry_send") &&
    [
      "check_requested",
      "version_seen",
      "inventory_requested",
      "inventory_received",
      "inventory_obsolete",
      "read_failed",
    ].includes(event.type)
  )
    return model;
  const reviewing = reviewRequired(model);
  switch (event.type) {
    case "check_requested":
    case "offer_changed":
      return {
        ...model,
        phase: "checking",
        failure: null,
        inventory: EMPTY,
        pending: null,
      };
    case "version_seen":
      if (!canEditOffer(event.offer))
        return {
          ...model,
          phase: "gone",
          candidate: event.offer,
          inventory: EMPTY,
          pending: null,
        };
      if (
        !reviewing &&
        offerVersion(event.offer) === offerVersion(model.reviewed)
      )
        return model;
      return {
        ...model,
        phase: "changed",
        candidate: event.offer,
        failure: null,
        inventory: EMPTY,
        pending: null,
      };
    case "inventory_requested":
      if (
        event.version !== offerVersion(model.reviewed) ||
        model.phase === "read_failed" ||
        reviewing ||
        model.phase === "sending" ||
        model.phase === "retry_send"
      )
        return model;
      return {
        ...model,
        phase: "loading",
        failure: null,
        inventory: { ...model.inventory, [event.side]: null },
      };
    case "inventory_received": {
      if (
        event.version !== offerVersion(model.reviewed) ||
        model.phase === "read_failed" ||
        reviewing ||
        model.phase === "sending" ||
        model.phase === "retry_send"
      )
        return model;
      const next = {
        ...model,
        inventory: { ...model.inventory, [event.side]: event.cards },
        failure: null,
      };
      return { ...next, phase: afterInventory(next) };
    }
    case "inventory_obsolete":
      if (event.version !== offerVersion(model.reviewed) || reviewing)
        return model;
      return {
        ...model,
        phase: "checking",
        inventory: EMPTY,
        pending: null,
        failure: null,
      };
    case "review_confirmed":
      if (!model.candidate || !reviewing || !canEditOffer(model.candidate))
        return model;
      return { ...initialOfferLifecycle(model.candidate), phase: "loading" };
    case "read_failed":
      // A superseded availability request must never hide the current confirmation controls.
      if (
        event.stage === "inventory" &&
        (reviewing || model.phase === "sending" || model.phase === "retry_send")
      )
        return model;
      return { ...model, phase: "read_failed", failure: event.stage };
    case "unavailable":
      return { ...model, phase: "gone", inventory: EMPTY, pending: null };
    case "send_requested":
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
      return {
        ...model,
        phase: "sending",
        pending: model.pending ?? {
          ...structuredClone(event.terms),
          offer_id: model.reviewed.offer_id,
          revision: model.reviewed.revision,
          idempotency_key: event.key,
        },
      };
    case "transport_failed":
      return model.phase === "sending" && model.pending
        ? { ...model, phase: "retry_send" }
        : model;
    case "send_refused":
      return model.phase === "sending"
        ? { ...model, phase: afterInventory(model), pending: null }
        : model;
    case "send_succeeded":
      return model.phase === "sending"
        ? { ...model, phase: "sent", pending: null }
        : model;
    case "retry":
      if (model.phase === "read_failed")
        return {
          ...model,
          phase: model.failure === "version" ? "checking" : "loading",
          failure: null,
        };
      return model;
    case "draft_edited":
      if (model.phase === "sending") return model;
      return {
        ...model,
        pending: null,
        phase:
          model.phase === "retry_send" ? afterInventory(model) : model.phase,
      };
  }
}
/** The page uses this policy for its actual recovery controls, not just for tests. */
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
