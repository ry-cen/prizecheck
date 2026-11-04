import { expect, it } from "vitest";
import type { TradeView } from "../social_generated";
import { counterProposal } from "./proposalModel";
import { offerVersion } from "./offerInventory";
import {
  canSendOffer,
  initialOfferLifecycle,
  offerCaps,
  offerControls,
  reviewRequired,
  transitionOffer as withEffects,
  type OfferEvent,
  type OfferLifecycle,
  type OfferPhase,
  type OfferRead,
  type ReadSource,
  type ReadResult,
  type PostResult,
} from "./offerLifecycle";
const transitionOffer = (model: OfferLifecycle, event: OfferEvent) =>
  withEffects(model, event).model;
const card = {
  edition_id: "Iono",
  name: "Iono",
  copies: "1",
  set_code: "PAL",
  set_name: "Paldea",
  collector_number: "185",
  descriptor: {},
  image_url: null,
};
const A: TradeView = {
  id: "A",
  offer_id: "A",
  thread_id: "thread",
  revision: 1,
  state: "proposed",
  closed_reason: null,
  closed_by: null,
  role: "recipient",
  other: {
    collector_id: null,
    handle: null,
    display_name: "Misty",
    open_to_cash_offers: false,
  },
  countered_from: null,
  you_give: [],
  you_get: [card],
  cash: null,
  you_confirmed_swap: false,
  they_confirmed_swap: false,
  needs_you: true,
  waiting: "answer",
  section: "needs_you",
  actions: ["counter"],
  created_at: "2026-11-04T00:00:00Z",
};
const B: TradeView = {
  ...A,
  id: "B",
  offer_id: "B",
  revision: 2,
  you_get: [{ ...card, copies: "2" }],
};
const closed: TradeView = {
  ...B,
  state: "closed",
  closed_reason: "withdrawn",
  actions: [],
};
const sources: ReadSource[] = ["version", "give", "get"];
function start(
  model: OfferLifecycle,
  source: ReadSource,
  version = offerVersion(model.reviewed)!
) {
  const next = transitionOffer(model, {
    type: "read_requested",
    source,
    version,
  });
  return {
    model: next,
    read: next.reads[next.nextRead] ?? { id: -1, source, version },
  };
}
const finish = (model: OfferLifecycle, read: OfferRead, result: ReadResult) =>
  transitionOffer(model, { type: "read_completed", read, result });
function inventory(model: OfferLifecycle, side: "give" | "get", copies = "2") {
  const request = start(model, side);
  return finish(request.model, request.read, {
    kind: "inventory",
    cards: side === "give" ? [] : [{ ...card, copies }],
  });
}
const ready = (model = initialOfferLifecycle(A), copies = "2") =>
  inventory(inventory(model, "give"), "get", copies);
const send = (model: OfferLifecycle, key = "held") =>
  transitionOffer(model, {
    type: "send_requested",
    terms: { you_get: [{ edition_id: "Iono", quantity: "1" }] },
    key,
  });
function post(model: OfferLifecycle, result: PostResult) {
  expect(model.activePost).not.toBeNull();
  return transitionOffer(model, {
    type: "post_completed",
    post: model.activePost!,
    result,
  });
}
function changed(model = ready(), offer = B) {
  const request = start(model, "version");
  return finish(request.model, request.read, { kind: "version", offer });
}
function cachedCrossing() {
  const request = start(changed(), "version");
  const confirmed = transitionOffer(request.model, {
    type: "review_confirmed",
  });
  return { model: confirmed, read: request.read };
}
function results(source: ReadSource): ReadResult[] {
  return source === "version"
    ? [
        { kind: "version", offer: A },
        { kind: "version", offer: B },
        { kind: "version", offer: closed },
        { kind: "not_found" },
        { kind: "failed" },
        { kind: "cancelled" },
      ]
    : [
        { kind: "inventory", cards: [card] },
        { kind: "inventory", cards: [] },
        { kind: "obsolete" },
        { kind: "not_found" },
        { kind: "failed" },
        { kind: "cancelled" },
      ];
}
/** Universal authority invariant, independent of expected phase tables or particular reply names. */
function retained(before: OfferLifecycle, after: OfferLifecycle) {
  if (!before.pending) return;
  expect(after.pending).toBe(before.pending);
  expect(JSON.stringify(after.pending)).toBe(JSON.stringify(before.pending));
  expect(after.pending?.idempotency_key).toBe(before.pending.idempotency_key);
  expect(after.activePost).toBe(before.activePost);
  expect(after.phase).toBe(before.phase);
  expect(after.reviewed).toBe(before.reviewed);
  expect(after.inventory).toBe(before.inventory);
  expect(canSendOffer(after)).toBe(canSendOffer(before));
  expect(offerControls(after).retry).toBe(offerControls(before).retry);
}
const phases: OfferPhase[] = [
  "loading",
  "ready",
  "checking",
  "changed",
  "read_failed",
  "gone",
  "sending",
  "retry_send",
  "sent",
];
const configurations = phases.flatMap((phase) =>
  (phase === "read_failed"
    ? (["version", "inventory"] as const)
    : [null]
  ).flatMap((failure) =>
    [false, true].flatMap((candidate) =>
      ["none", "give", "get", "both"].flatMap((counts) =>
        ["none", "current", "superseded", "old-version"].flatMap((flight) =>
          sources.map((source) => ({
            phase,
            failure,
            candidate,
            counts,
            flight,
            source,
          }))
        )
      )
    )
  )
);

it.each(configurations)(
  "background safety: $phase candidate=$candidate counts=$counts flight=$flight source=$source failure=$failure",
  ({ phase, failure, candidate, counts, flight, source }) => {
    // Cross actual records/payloads as well as phases. Adversarial metadata permutations test the
    // authority boundary even when an earlier invariant would usually prevent that combination.
    const issuing = send(ready());
    let model: OfferLifecycle = {
      ...initialOfferLifecycle(A),
      phase,
      candidate: candidate ? B : null,
      failure,
      inventory: {
        give: counts === "give" || counts === "both" ? [] : null,
        get: counts === "get" || counts === "both" ? [card] : null,
      },
      pending:
        phase === "sending" || phase === "retry_send" ? issuing.pending : null,
      activePost: phase === "sending" ? issuing.activePost : null,
    };
    const before = model;
    let request = {
      model,
      read: { id: -1, source, version: offerVersion(A)! },
    };
    if (flight !== "none")
      request = start(
        model,
        source,
        flight === "old-version" ? "thread/older/1" : offerVersion(A)!
      );
    retained(before, request.model);
    model = request.model;
    if (flight === "superseded") {
      const newer = start(model, source);
      retained(model, newer.model);
      model = newer.model;
    }
    for (const result of results(source)) {
      const original = JSON.stringify(model);
      const next = finish(model, request.read, result);
      retained(model, next);
      expect(JSON.stringify(model)).toBe(original); // transition is pure
      if (model.reads[request.read.id])
        expect(next.reads[request.read.id]).toBeUndefined();
      if (reviewRequired(next)) expect(offerControls(next).send).toBe(false);
    }
    for (const version of [offerVersion(model.reviewed)!, "obsolete-version"]) {
      const invalidated = withEffects(model, { type: "invalidated", version });
      retained(model, invalidated.model);
    }
    const foreground: OfferEvent[] = [
      { type: "review_confirmed" },
      { type: "retry" },
      { type: "draft_edited" },
      { type: "start" },
      { type: "selection_changed", editions: ["Iono", "Boss"] },
      { type: "send_requested", terms: {}, key: "new-command" },
      ...(
        ["success", "unknown", "not_found", "changed", "refused"] as const
      ).flatMap((result) => [
        {
          type: "post_completed" as const,
          post: model.activePost ?? { attempt: -1, key: "absent" },
          result,
        },
        {
          type: "post_completed" as const,
          post: { attempt: -1, key: "stale" },
          result,
        },
      ]),
    ];
    for (const event of foreground) {
      const original = JSON.stringify(model);
      const next = transitionOffer(model, event);
      expect(JSON.stringify(model)).toBe(original);
      if (model.phase === "gone" || model.phase === "sent")
        expect(next).toBe(model);
      if (event.type === "send_requested" && !canSendOffer(model))
        expect(next).toBe(model);
      if (event.type === "send_requested" && !model.pending && next.pending) {
        expect(next.pending.offer_id).toBe(model.reviewed.offer_id);
        expect(next.pending.revision).toBe(model.reviewed.revision);
      }
      if (event.type === "post_completed" && event.post.attempt === -1)
        expect(next).toBe(model);
    }
  }
);
it.each(["sending", "retry_send"])(
  "retains exact replay after a current-context GET404 during %s",
  (phase) => {
    let model = send(ready());
    if (phase === "retry_send") model = post(model, "unknown");
    const request = start(model, "version");
    model = finish(request.model, request.read, { kind: "not_found" });
    expect(model.pending).not.toBeNull();
    expect("observed" in model).toBe(false);
    if (phase === "sending") model = post(model, "unknown");
    expect(canSendOffer(model)).toBe(true);
    const bytes = JSON.stringify(model.pending);
    model = send(model, "must-not-replace-key");
    expect(JSON.stringify(model.pending)).toBe(bytes);
    expect(post(model, "success").phase).toBe("sent"); // active POST wins over old GET
  }
);
it.each(results("version"))(
  "discards retained observations and requests a fresh review after known refusal: $kind",
  (result) => {
    const request = start(send(ready()), "version");
    const observed = finish(request.model, request.read, result);
    retained(request.model, observed);
    const settled = post(observed, "refused");
    expect(settled.pending).toBeNull();
    expect(settled.phase).toBe("checking");
    expect(settled.candidate).toBeNull();
    expect(Object.values(settled.reads).map((read) => read.source)).toEqual([
      "version",
    ]);
    expect("observed" in settled).toBe(false);
    const fresh = Object.values(settled.reads)[0];
    const checked = finish(settled, fresh, { kind: "version", offer: B });
    expect(checked.phase).toBe("changed");
    expect(offerControls(checked).review).toBe(true);
    expect(canSendOffer(checked)).toBe(false);
  }
);
it("keeps definitive not-found from the active POST terminal, and refuses stale POST outcomes", () => {
  const issuing = send(ready());
  expect(
    transitionOffer(issuing, {
      type: "post_completed",
      post: { attempt: 999, key: "held" },
      result: "not_found",
    })
  ).toBe(issuing);
  const unknown = post(issuing, "unknown");
  const again = send(unknown);
  expect(
    transitionOffer(again, {
      type: "post_completed",
      post: issuing.activePost!,
      result: "not_found",
    })
  ).toBe(again);
  const gone = post(again, "not_found");
  expect(gone.pending).toBeNull();
  expect(gone.phase).toBe("gone");
  expect(offerControls(gone).send).toBe(false);
});
it("rejects obsolete inventory after review and recomputes smaller caps without trimming draft quantities", () => {
  expect(offerCaps(ready(), counterProposal(A)).proposal.get[0].copies).toBe(
    "3"
  );
  const old = start(changed(), "get");
  const confirmed = transitionOffer(old.model, { type: "review_confirmed" });
  const stale = finish(confirmed, old.read, {
    kind: "inventory",
    cards: [{ ...card, copies: "2" }],
  });
  expect(stale.inventory).toBe(confirmed.inventory);
  expect(offerControls(stale).send).toBe(false);
  const fresh = ready(stale, "1");
  const draft = counterProposal({
    you_give: [],
    you_get: [{ ...card, copies: "4" }],
  });
  const caps = offerCaps(fresh, draft);
  expect(caps.proposal.get[0].copies).toBe("3");
  expect(caps.proposal.get[0].quantity).toBe(4);
  expect(caps.overCap).toBe(true);
  expect(
    transitionOffer(fresh, {
      type: "send_requested",
      terms: { you_get: [{ edition_id: "Iono", quantity: "4" }] },
      key: "bad",
    }).pending
  ).toBeNull();
});
it("keeps failed inventory recovery until Retry and retains cached review beside a failed check", () => {
  const request = start(initialOfferLifecycle(A), "give");
  let failed = finish(request.model, request.read, { kind: "failed" });
  failed = inventory(failed, "get");
  expect(failed.phase).toBe("read_failed");
  expect(offerControls(failed).retry).toBe("inventory");
  expect(ready(transitionOffer(failed, { type: "retry" })).phase).toBe("ready");
  const check = start(changed(), "version");
  const cached = finish(check.model, check.read, { kind: "failed" });
  expect(cached.candidate).toBe(B);
  expect(offerControls(cached)).toMatchObject({
    review: true,
    retry: "check",
    send: false,
  });
});
it("retains byte-identical unknown retries and clears only on explicit edit or a known command refusal", () => {
  const issuing = send(ready());
  const unknown = post(issuing, "unknown");
  const again = send(unknown, "other");
  expect(again.pending).toBe(issuing.pending);
  expect(transitionOffer(unknown, { type: "draft_edited" }).pending).toBeNull();
  expect(post(issuing, "refused").pending).toBeNull();
});
it("requires review after a version refusal even if its fresh read has the same version", () => {
  const refused = post(send(ready()), "changed");
  const [request] = Object.values(refused.reads);
  const checked = finish(refused, request, {
    kind: "version",
    offer: A,
  });
  expect(checked.phase).toBe("changed");
  expect(canSendOffer(checked)).toBe(false);
});

it("a request for an older reviewed version cannot supersede the current version's pending read", () => {
  const current = start(initialOfferLifecycle(B), "get");
  const old = start(current.model, "get", offerVersion(A)!);
  expect(old.model.latestRead.get).toBe(current.read.id);
  const accepted = finish(old.model, current.read, {
    kind: "inventory",
    cards: [card],
  });
  expect(accepted.inventory.get).toEqual([card]);
});

// The executor journal is distinct from the model: a registered ticket counts as I/O only if an effect issued it.
type Recovery = {
  model: OfferLifecycle;
  io: Set<string>;
  library: "loading" | "ready" | "failed";
  libraryVersion: string;
  observedInTrace: boolean;
};
type Move =
  | { kind: "model"; event: OfferEvent }
  | { kind: "library_reply"; result: "ready" | "failed" | "obsolete" }
  | { kind: "library_retry" };
function perform(state: Recovery, move: Move): Recovery {
  let library = state.library;
  let libraryVersion = state.libraryVersion;
  let event: OfferEvent;
  if (move.kind === "library_reply") {
    expect(library).toBe("loading");
    library = move.result === "ready" ? "ready" : "failed";
    if (move.result !== "obsolete") return { ...state, library };
    event = { type: "invalidated", version: libraryVersion };
  } else if (move.kind === "library_retry") {
    expect(library).toBe("failed");
    library = "loading";
    libraryVersion = offerVersion(state.model.reviewed)!;
    // The actual page's library Retry starts its searched read and requests selected-edition inventory.
    event = { type: "read_requested", source: "get" };
  } else event = move.event;
  const next = withEffects(state.model, event);
  const io = new Set(state.io);
  if (event.type === "read_completed") io.delete(`read:${event.read.id}`);
  if (event.type === "post_completed") io.delete(`post:${event.post.attempt}`);
  for (const effect of next.effects) {
    if (effect.kind === "cancel") io.delete(`read:${effect.read.id}`);
    else if (effect.kind === "read") io.add(`read:${effect.read.id}`);
    else io.add(`post:${effect.post.attempt}`);
  }
  if (event.type === "review_confirmed" && next.model !== state.model) {
    library = "loading";
    libraryVersion = offerVersion(next.model.reviewed)!;
  }
  if (
    event.type === "read_requested" ||
    event.type === "read_completed" ||
    event.type === "invalidated"
  )
    retained(state.model, next.model);
  return {
    model: next.model,
    io,
    library,
    libraryVersion,
    observedInTrace:
      state.observedInTrace ||
      (state.model.pending !== null &&
        (event.type === "read_completed" ||
          event.type === "read_requested" ||
          event.type === "invalidated")),
  };
}
/** No read is manufactured here: only executor-issued replies or actual enabled page actions can occur. */
function recoveryMoves(state: Recovery): Move[] {
  const { model } = state;
  if (model.phase === "gone" || model.phase === "sent") return [];
  const moves: Move[] = [];
  for (const read of Object.values(model.reads)) {
    expect(state.io.has(`read:${read.id}`)).toBe(true);
    for (const result of results(read.source))
      moves.push({
        kind: "model",
        event: { type: "read_completed", read, result },
      });
  }
  if (model.activePost) {
    expect(state.io.has(`post:${model.activePost.attempt}`)).toBe(true);
    for (const result of [
      "success",
      "unknown",
      "not_found",
      "changed",
      "refused",
    ] as const)
      moves.push({
        kind: "model",
        event: { type: "post_completed", post: model.activePost, result },
      });
  }
  const controls = offerControls(model);
  if (controls.review)
    moves.push({ kind: "model", event: { type: "review_confirmed" } });
  if (controls.retry === "check")
    moves.push({
      kind: "model",
      event: { type: "read_requested", source: "version" },
    });
  if (controls.retry === "inventory")
    moves.push({ kind: "model", event: { type: "retry" } });
  if (controls.send)
    moves.push({
      kind: "model",
      event: {
        type: "send_requested",
        key: "explore",
        terms: {
          you_get: [{ edition_id: "Iono", quantity: "1" }],
          cash: { payer: "them", cents: "1" },
        },
      },
    });
  // A quantity/cash edit is available after an unknown answer; it intentionally abandons that exact replay.
  if (model.phase === "retry_send")
    moves.push({ kind: "model", event: { type: "draft_edited" } });
  if (state.library === "loading")
    for (const result of ["ready", "failed", "obsolete"] as const)
      moves.push({ kind: "library_reply", result });
  if (state.library === "failed") moves.push({ kind: "library_retry" });
  return moves;
}
function progress(state: Recovery) {
  const { model } = state;
  if (model.phase === "gone" || model.phase === "sent") return true;
  const issued = Object.values(model.reads).some((read) =>
    state.io.has(`read:${read.id}`)
  );
  const posting =
    model.activePost !== null &&
    state.io.has(`post:${model.activePost.attempt}`);
  if (model.phase === "checking")
    return Object.values(model.reads).some(
      (read) => read.source === "version" && state.io.has(`read:${read.id}`)
    );
  if (model.phase === "sending") return posting;
  const controls = offerControls(model);
  // Back and unrelated library/search activity cannot certify recovery of the retained draft.
  return (
    issued ||
    posting ||
    controls.review ||
    controls.send ||
    controls.retry !== null
  );
}
function recoveryKey(state: Recovery) {
  const m = state.model;
  return JSON.stringify([
    m.phase,
    m.reviewed.offer_id,
    m.candidate?.offer_id,
    m.failure,
    m.checkConsent,
    m.inventory,
    m.pending,
    state.observedInTrace,
    !!m.activePost,
    Object.values(m.reads)
      .map((read) => [read.source, read.version])
      .sort(),
    state.library,
    state.libraryVersion,
  ]);
}
// The collector has edited cash (they pay one cent alongside their card), so each ready draft differs from A/B.
// One copy always fits their existing reservation, even when an availability page is empty.
it("checks liveness after every reachable step using only real effects, pending replies and visible controls, including library Retry during send", () => {
  const initial: Recovery = {
    model: initialOfferLifecycle(A),
    io: new Set(),
    library: "loading",
    libraryVersion: offerVersion(A)!,
    observedInTrace: false,
  };
  const root = perform(initial, { kind: "model", event: { type: "start" } });
  const queue = [{ state: root, depth: 0 }];
  const seen = new Set<string>();
  const visitedPhases = new Set<OfferPhase>();
  let libraryRetryDuringSend = false,
    settledObservation = false;
  for (let index = 0; index < queue.length; index++) {
    const { state, depth } = queue[index];
    visitedPhases.add(state.model.phase);
    expect(progress(state), `requestless/actionless ${state.model.phase}`).toBe(
      true
    );
    const key = recoveryKey(state);
    if (seen.has(key)) continue;
    seen.add(key);
    if (depth === 9) continue;
    for (const move of recoveryMoves(state)) {
      const next = perform(state, move);
      expect(
        progress(next),
        `after ${JSON.stringify(move)}: ${next.model.phase}`
      ).toBe(true);
      libraryRetryDuringSend ||=
        move.kind === "library_retry" && state.model.phase === "sending";
      settledObservation ||=
        state.observedInTrace &&
        next.model.phase === "checking" &&
        !next.model.pending;
      queue.push({ state: next, depth: depth + 1 });
    }
  }
  expect(seen.size).toBeGreaterThan(100);
  expect([...visitedPhases].sort()).toEqual([...phases].sort());
  expect(libraryRetryDuringSend).toBe(true);
  expect(settledObservation).toBe(true);
});

it.each(["refused", "edit-after-unknown"] as const)(
  "S1-08 settles %s by issuing a fresh observation, never by replaying old payloads",
  (outcome) => {
    const version = start(send(ready()), "version");
    const selected = start(version.model, "get");
    let model = finish(selected.model, selected.read, { kind: "obsolete" });
    model = finish(model, version.read, { kind: "version", offer: A });
    if (outcome === "refused") model = post(model, "refused");
    else
      model = transitionOffer(post(model, "unknown"), { type: "draft_edited" });
    expect(model.phase).toBe("checking");
    expect(model.pending).toBeNull();
    expect(model.candidate).toBeNull();
    expect("deferred" in model).toBe(false);
    const [fresh] = Object.values(model.reads);
    expect(fresh.source).toBe("version");
    expect(fresh.id).toBeGreaterThan(selected.read.id);
    const checked = finish(model, fresh, { kind: "version", offer: B });
    expect(canSendOffer(checked)).toBe(false);
    expect(checked.reviewed).toBe(A);
    const confirmed = withEffects(checked, { type: "review_confirmed" });
    expect(
      confirmed.effects
        .filter((effect) => effect.kind === "read")
        .map((effect) => effect.read.source)
        .sort()
    ).toEqual(["get", "give"]);
    model = confirmed.model;
    for (const read of Object.values(model.reads))
      model = finish(model, read, {
        kind: "inventory",
        cards: read.source === "give" ? [] : [card],
      });
    expect(canSendOffer(model)).toBe(true);
    const issued = withEffects(model, {
      type: "send_requested",
      key: "fresh",
      terms: { you_get: [{ edition_id: "Iono", quantity: "1" }] },
    });
    expect(
      issued.effects.filter((effect) => effect.kind === "post")
    ).toHaveLength(1);
    expect(issued.model.pending).toMatchObject({
      offer_id: "B",
      revision: 2,
      idempotency_key: "fresh",
    });
  }
);

it.each(["refused", "edit-after-unknown"] as const)(
  "S1-09 always issues a fresh read after quiet %s and reloads same-version inventories without confirmation",
  (outcome) => {
    const issuing = send(ready());
    const result =
      outcome === "refused"
        ? withEffects(issuing, {
            type: "post_completed",
            post: issuing.activePost!,
            result: "refused",
          })
        : withEffects(post(issuing, "unknown"), { type: "draft_edited" });
    expect(result.model.phase).toBe("checking");
    expect(result.model.pending).toBeNull();
    expect("observed" in result.model).toBe(false);
    const reads = result.effects.filter((effect) => effect.kind === "read");
    expect(reads).toHaveLength(1);
    expect(reads[0].read.source).toBe("version");
    const fresh = withEffects(result.model, {
      type: "read_completed",
      read: reads[0].read,
      result: { kind: "version", offer: A },
    });
    expect(fresh.model.phase).toBe("loading");
    expect(fresh.model.candidate).toBeNull();
    expect(fresh.model.reviewed).toBe(A);
    expect(offerControls(fresh.model).review).toBe(false);
    expect(canSendOffer(fresh.model)).toBe(false);
    expect(
      fresh.effects
        .filter((effect) => effect.kind === "read")
        .map((effect) => effect.read.source)
        .sort()
    ).toEqual(["get", "give"]);
    let model = fresh.model;
    for (const read of Object.values(model.reads))
      model = finish(model, read, {
        kind: "inventory",
        cards: read.source === "give" ? [] : [card],
      });
    expect(model.phase).toBe("ready");
    expect(canSendOffer(model)).toBe(true);
  }
);

it.each(["refused", "edit-after-unknown"] as const)(
  "S1-09 preserves same-version verification through a failed fresh read and visible Retry after %s",
  (outcome) => {
    const issued = send(ready());
    let model =
      outcome === "refused"
        ? post(issued, "refused")
        : transitionOffer(post(issued, "unknown"), { type: "draft_edited" });
    const [first] = Object.values(model.reads);
    model = finish(model, first, { kind: "failed" });
    expect(offerControls(model).retry).toBe("check");
    const retry = withEffects(model, {
      type: "read_requested",
      source: "version",
    });
    const [effect] = retry.effects.filter((effect) => effect.kind === "read");
    expect(effect.read.id).toBeGreaterThan(first.id);
    expect(retry.model.checkConsent).toBe("if_changed");
    const fresh = withEffects(retry.model, {
      type: "read_completed",
      read: effect.read,
      result: { kind: "version", offer: A },
    });
    expect(fresh.model.phase).toBe("loading");
    expect(offerControls(fresh.model).review).toBe(false);
    expect(
      fresh.effects
        .filter((effect) => effect.kind === "read")
        .map((effect) => effect.read.source)
        .sort()
    ).toEqual(["get", "give"]);
  }
);
