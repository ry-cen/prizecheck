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
export type OfferRead = {
  id: number;
  source: ReadSource;
  version: string;
};
export type ReadResult =
  | { kind: "version"; offer: TradeView }
  | { kind: "inventory"; cards: readonly ProposalCard[] }
  | { kind: "not_found" | "obsolete" | "failed" | "cancelled" };
export type ReadCompletion = { read: OfferRead; result: ReadResult };
export type OfferPost = { attempt: number; key: string };
export type PostResult =
  "success" | "unknown" | "not_found" | "changed" | "refused";
export type OfferEffect =
  | {
      kind: "read";
      read: OfferRead;
      offer: TradeView;
      editions: readonly string[];
    }
  | { kind: "cancel"; read: OfferRead }
  | { kind: "post"; post: OfferPost; body: ChangeOffer; thread: string };
export type OfferLifecycle = {
  phase: OfferPhase;
  reviewed: TradeView;
  candidate: TradeView | null;
  inventory: Record<InventorySide, readonly ProposalCard[] | null>;
  failure: "version" | "inventory" | null;
  checkConsent: "required" | "if_changed";
  pending: ChangeOffer | null;
  nextRead: number;
  reads: Record<number, OfferRead>;
  latestRead: Partial<Record<ReadSource, number>>;
  selected: readonly string[];
  nextPost: number;
  activePost: OfferPost | null;
};
export type OfferEvent =
  | { type: "start" }
  | { type: "read_requested"; source: ReadSource; version?: string }
  | { type: "selection_changed"; editions: readonly string[] }
  | { type: "invalidated"; version: string }
  | ({ type: "read_completed" } & ReadCompletion)
  | { type: "review_confirmed" }
  | { type: "send_requested"; terms: OfferTerms; key: string }
  | { type: "post_completed"; post: OfferPost; result: PostResult }
  | { type: "retry" | "draft_edited" };
export type OfferTransition = { model: OfferLifecycle; effects: OfferEffect[] };
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
    checkConsent: "required",
    pending: null,
    nextRead: 0,
    reads: {},
    latestRead: {},
    selected: reviewed.you_get.map((card) => card.edition_id).sort(),
    nextPost: 0,
    activePost: null,
  };
}
export function inventoryReady(model: OfferLifecycle) {
  return model.inventory.give !== null && model.inventory.get !== null;
}
export function reviewRequired(model: OfferLifecycle) {
  return (
    ["checking", "changed", "gone"].includes(model.phase) ||
    (model.phase === "read_failed" && model.failure === "version")
  );
}
export function canSendOffer(model: OfferLifecycle) {
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
/** Every phase change and the I/O needed to progress are decided together. */
export function transitionOffer(
  before: OfferLifecycle,
  event: OfferEvent
): OfferTransition {
  const effects: OfferEffect[] = [];
  const done = (model: OfferLifecycle): OfferTransition => ({ model, effects });
  function cancel(model: OfferLifecycle, source?: ReadSource) {
    const reads = { ...model.reads };
    for (const read of Object.values(reads))
      if (source === undefined || read.source === source) {
        effects.push({ kind: "cancel", read });
        delete reads[read.id];
      }
    return { ...model, reads };
  }
  function issue(model: OfferLifecycle, source: ReadSource) {
    const next = cancel(model, source);
    const read: OfferRead = {
      id: model.nextRead + 1,
      source,
      version: offerVersion(model.reviewed)!,
    };
    effects.push({
      kind: "read",
      read,
      offer: model.reviewed,
      editions: model.selected,
    });
    return {
      ...next,
      nextRead: read.id,
      reads: { ...next.reads, [read.id]: read },
      latestRead: { ...next.latestRead, [source]: read.id },
    };
  }
  function check(
    model: OfferLifecycle,
    consent: "required" | "if_changed" = "required",
    keepCandidate = false
  ) {
    // Start a NEW observation; no previously completed or delayed reply can become the candidate.
    return issue(
      {
        ...cancel(model),
        phase: "checking",
        candidate: keepCandidate ? model.candidate : null,
        checkConsent: consent,
        inventory: EMPTY,
        failure: null,
      },
      "version"
    );
  }
  function inventories(model: OfferLifecycle) {
    let next = model;
    for (const source of ["give", "get"] as const)
      if (
        next.inventory[source] === null &&
        !Object.values(next.reads).some(
          (read) => currentRead(next, read) && read.source === source
        )
      )
        next = issue(next, source);
    return next;
  }
  function release(model: OfferLifecycle) {
    return check({ ...model, pending: null, activePost: null }, "if_changed");
  }
  if (event.type === "read_completed") {
    const outstanding = before.reads[event.read.id];
    if (
      !outstanding ||
      outstanding.source !== event.read.source ||
      outstanding.version !== event.read.version
    )
      return done(before);
    const reads = { ...before.reads };
    delete reads[event.read.id];
    const model = { ...before, reads };
    if (terminal(model) || !currentRead(model, event.read)) return done(model);
    // A retained command has sole authority. Store no reply payload or ordering to replay later.
    if (model.pending) return done(model);
    const result = event.result;
    if (event.read.source === "version") {
      if (result.kind === "not_found")
        return done({
          ...cancel(model),
          phase: "gone",
          inventory: EMPTY,
          failure: null,
        });
      if (result.kind !== "version")
        return done({ ...model, phase: "read_failed", failure: "version" });
      if (!canEditOffer(result.offer))
        return done({
          ...cancel(model),
          phase: "gone",
          candidate: result.offer,
          inventory: EMPTY,
          failure: null,
        });
      if (
        model.checkConsent === "if_changed" &&
        offerVersion(result.offer) === offerVersion(model.reviewed)
      )
        return done(
          inventories({
            ...cancel(model),
            phase: "loading",
            candidate: null,
            inventory: EMPTY,
            failure: null,
          })
        );
      return done({
        ...cancel(model),
        phase: "changed",
        candidate: result.offer,
        inventory: EMPTY,
        failure: null,
      });
    }
    if (reviewRequired(model) || model.phase === "read_failed")
      return done(model);
    if (result.kind === "obsolete" || result.kind === "not_found")
      return done(check(model));
    if (result.kind !== "inventory")
      return done({ ...model, phase: "read_failed", failure: "inventory" });
    const next = {
      ...model,
      inventory: { ...model.inventory, [event.read.source]: result.cards },
      failure: null,
    };
    return done(inventories({ ...next, phase: afterInventory(next) }));
  }
  if (terminal(before)) return done(before);
  switch (event.type) {
    case "start":
      return done(before.phase === "loading" ? inventories(before) : before);
    case "read_requested": {
      if (event.version && event.version !== offerVersion(before.reviewed))
        return done(before);
      if (event.source === "version" && !before.pending)
        return done(
          check(
            before,
            before.phase === "read_failed" && before.failure === "version"
              ? before.checkConsent
              : "required",
            true
          )
        );
      const model = issue(before, event.source);
      if (before.pending) return done(model);
      if (reviewRequired(before) || before.phase === "read_failed")
        return done(model);
      return done({
        ...model,
        phase: "loading",
        inventory: { ...model.inventory, [event.source]: null },
        failure: null,
      });
    }
    case "selection_changed": {
      const selected = [...new Set(event.editions)].sort();
      if (JSON.stringify(selected) === JSON.stringify(before.selected))
        return done(before);
      const model = { ...before, selected };
      if (
        before.pending ||
        reviewRequired(before) ||
        before.phase === "read_failed"
      )
        return done(model);
      return done(
        issue(
          {
            ...model,
            phase: "loading",
            inventory: { ...model.inventory, get: null },
          },
          "get"
        )
      );
    }
    case "invalidated":
      if (event.version !== offerVersion(before.reviewed)) return done(before);
      return done(before.pending ? before : check(before));
    case "review_confirmed":
      if (
        !before.candidate ||
        !reviewRequired(before) ||
        !canEditOffer(before.candidate)
      )
        return done(before);
      return done(
        inventories({
          ...cancel(before),
          phase: "loading",
          reviewed: before.candidate,
          candidate: null,
          inventory: EMPTY,
          failure: null,
        })
      );
    case "send_requested": {
      if (!canSendOffer(before)) return done(before);
      if (
        !before.pending &&
        !(["give", "get"] as const).every((side) => {
          const available = new Map(
            offerLibrary(before.inventory[side]!, before.reviewed, side).map(
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
        return done(before);
      const pending = before.pending ?? {
        ...structuredClone(event.terms),
        offer_id: before.reviewed.offer_id,
        revision: before.reviewed.revision,
        idempotency_key: event.key,
      };
      const post = {
        attempt: before.nextPost + 1,
        key: pending.idempotency_key,
      };
      effects.push({
        kind: "post",
        post,
        body: pending,
        thread: before.reviewed.thread_id,
      });
      return done({
        ...before,
        phase: "sending",
        pending,
        nextPost: post.attempt,
        activePost: post,
      });
    }
    case "post_completed": {
      if (
        before.phase !== "sending" ||
        !before.pending ||
        event.post.attempt !== before.activePost?.attempt ||
        event.post.key !== before.pending.idempotency_key
      )
        return done(before);
      if (event.result === "unknown")
        return done({ ...before, phase: "retry_send", activePost: null });
      const model = { ...before, pending: null, activePost: null };
      if (event.result === "success" || event.result === "not_found")
        return done({
          ...cancel(model),
          phase: event.result === "success" ? "sent" : "gone",
          inventory: event.result === "success" ? model.inventory : EMPTY,
          failure: null,
        });
      return done(event.result === "changed" ? check(model) : release(model));
    }
    case "retry":
      if (before.phase === "read_failed" && before.failure === "version")
        return done(check(before, before.checkConsent));
      if (before.phase === "read_failed" || before.phase === "loading")
        return done(
          inventories({ ...before, phase: "loading", failure: null })
        );
      return done(before);
    case "draft_edited":
      return done(
        before.phase !== "sending" && before.pending ? release(before) : before
      );
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
