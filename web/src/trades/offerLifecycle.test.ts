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
  transitionOffer,
  type OfferEvent,
  type OfferLifecycle,
  type OfferPhase,
  type OfferRead,
  type ReadSource,
  type ReadResult,
  type PostResult,
} from "./offerLifecycle";
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
    type: "read_started",
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
    const foreground: OfferEvent[] = [
      { type: "review_confirmed" },
      { type: "retry" },
      { type: "draft_edited" },
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
    expect(model.deferred).toHaveLength(1);
    if (phase === "sending") model = post(model, "unknown");
    expect(canSendOffer(model)).toBe(true);
    const bytes = JSON.stringify(model.pending);
    model = send(model, "must-not-replace-key");
    expect(JSON.stringify(model.pending)).toBe(bytes);
    expect(post(model, "success").phase).toBe("sent"); // active POST wins over old GET
  }
);
it.each([
  { result: { kind: "not_found" } as ReadResult, phase: "gone" },
  { result: { kind: "version", offer: B } as ReadResult, phase: "changed" },
  { result: { kind: "version", offer: closed } as ReadResult, phase: "gone" },
  { result: { kind: "failed" } as ReadResult, phase: "read_failed" },
])(
  "applies deferred $phase observation only after a definitive command refusal",
  ({ result, phase }) => {
    const request = start(send(ready()), "version");
    const observed = finish(request.model, request.read, result);
    expect(observed.phase).toBe("sending");
    expect(observed.pending).not.toBeNull();
    const settled = post(observed, "refused");
    expect(settled.pending).toBeNull();
    expect(settled.phase).toBe(phase);
    const controls = offerControls(settled);
    expect(controls.back).toBe(true);
    if (phase === "changed") expect(controls.review).toBe(true);
    if (phase === "read_failed") expect(controls.retry).toBe("check");
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
  const request = start(refused, "version");
  const checked = finish(request.model, request.read, {
    kind: "version",
    offer: A,
  });
  expect(checked.phase).toBe("changed");
  expect(canSendOffer(checked)).toBe(false);
});

function signature(model: OfferLifecycle) {
  return JSON.stringify([
    model.phase,
    model.reviewed.offer_id,
    model.candidate?.offer_id,
    model.failure,
    model.inventory.give?.map((c) => c.copies),
    model.inventory.get?.map((c) => c.copies),
    model.pending,
    !!model.activePost,
    Object.values(model.reads)
      .map((r) => [r.source, r.version, model.latestRead[r.source] === r.id])
      .sort(),
    model.deferred.map((c) => [
      c.read.source,
      c.read.version,
      model.latestRead[c.read.source] === c.read.id,
      c.result,
    ]),
  ]);
}
/** Only actual outstanding reads/posts can produce replies; UI actions schedule missing requests. */
function possible(model: OfferLifecycle): OfferEvent[] {
  const events: OfferEvent[] = [];
  const active = (source: ReadSource) =>
    Object.values(model.reads).some(
      (r) => r.source === source && r.version === offerVersion(model.reviewed)
    );
  if (model.phase === "loading")
    for (const source of ["give", "get"] as const)
      if (model.inventory[source] === null && !active(source))
        events.push({
          type: "read_started",
          source,
          version: offerVersion(model.reviewed)!,
        });
  if (model.phase === "checking" && !active("version"))
    events.push({
      type: "read_started",
      source: "version",
      version: offerVersion(model.reviewed)!,
    });
  const controls = offerControls(model);
  if (controls.review) events.push({ type: "review_confirmed" });
  if (controls.retry && model.phase === "read_failed")
    events.push({ type: "retry" });
  if (controls.send)
    events.push({ type: "send_requested", terms: {}, key: "explore" });
  if (model.activePost)
    for (const result of [
      "success",
      "unknown",
      "refused",
      "changed",
      "not_found",
    ] as const)
      events.push({ type: "post_completed", post: model.activePost, result });
  for (const read of Object.values(model.reads))
    for (const result of results(read.source))
      events.push({ type: "read_completed", read, result });
  return events;
}
function recover(model: OfferLifecycle) {
  for (let step = 0; step < 16; step++) {
    if (["ready", "gone", "sent"].includes(model.phase)) return true;
    const controls = offerControls(model);
    if (model.activePost) {
      model = post(model, "success");
      continue;
    }
    if (model.phase === "retry_send") {
      model = send(model);
      continue;
    }
    if (model.phase === "read_failed") {
      model = transitionOffer(model, { type: "retry" });
      continue;
    }
    if (controls.review) {
      model = transitionOffer(model, { type: "review_confirmed" });
      continue;
    }
    const expectedSource: ReadSource =
      model.phase === "checking"
        ? "version"
        : model.inventory.give === null
          ? "give"
          : "get";
    let read = Object.values(model.reads).find(
      (r) =>
        r.source === expectedSource &&
        r.version === offerVersion(model.reviewed)
    );
    if (!read) {
      const issued = start(model, expectedSource);
      model = issued.model;
      read = issued.read;
    }
    model = finish(
      model,
      read,
      read.source === "version"
        ? { kind: "version", offer: model.reviewed }
        : { kind: "inventory", cards: [] }
    );
  }
  return false;
}
it("explores bounded reordering of outstanding I/O, cached confirmation and exact replay, with visible recovery", () => {
  const crossing = cachedCrossing();
  const seeds = [
    initialOfferLifecycle(A),
    changed(),
    crossing.model,
    ready(crossing.model, "1"),
    send(ready(crossing.model, "1")),
  ];
  const queue = seeds.map((model) => ({ model, depth: 0 }));
  const seen = new Set<string>();
  let lateMissingSending = false,
    lateMissingRetry = false,
    replyCount = 0;
  while (queue.length) {
    const { model, depth } = queue.shift()!;
    const key = signature(model);
    if (seen.has(key)) continue;
    seen.add(key);
    expect(recover(model)).toBe(true);
    if (depth === 8 || model.phase === "gone" || model.phase === "sent")
      continue;
    const events = possible(model);
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      const next = transitionOffer(model, event);
      if (event.type === "read_started" || event.type === "read_completed")
        retained(model, next);
      if (event.type === "read_completed") {
        expect(model.reads[event.read.id]).toEqual(event.read);
        replyCount++;
        if (event.result.kind === "not_found" && model.pending) {
          lateMissingSending ||= model.phase === "sending";
          lateMissingRetry ||= model.phase === "retry_send";
        }
      }
      queue.push({ model: next, depth: depth + 1 });
    }
  }
  expect(seen.size).toBeGreaterThan(100);
  expect(replyCount).toBeGreaterThan(100);
  expect(lateMissingSending).toBe(true);
  expect(lateMissingRetry).toBe(true);
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
