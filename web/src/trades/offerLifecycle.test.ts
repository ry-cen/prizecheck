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
const original: TradeView = {
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
const replacement = {
  ...original,
  id: "B",
  offer_id: "B",
  revision: 2,
  you_get: [{ ...card, copies: "2" }],
};
const version = offerVersion(original)!;
const loading = initialOfferLifecycle(original);
const ready = transitionOffer(
  transitionOffer(loading, {
    type: "inventory_received",
    side: "give",
    version,
    cards: [],
  }),
  {
    type: "inventory_received",
    side: "get",
    version,
    cards: [{ ...card, copies: "2" }],
  }
);
const sending = transitionOffer(ready, {
  type: "send_requested",
  terms: { you_get: [{ edition_id: "Iono", quantity: "2" }] },
  key: "held",
});
const changed = transitionOffer(ready, {
  type: "version_seen",
  offer: replacement,
});
const states: Record<OfferPhase | "inventory_failed", OfferLifecycle> = {
  loading,
  inventory_failed: transitionOffer(loading, {
    type: "read_failed",
    stage: "inventory",
  }),
  ready,
  sending,
  changed,
  checking: transitionOffer(ready, { type: "check_requested" }),
  read_failed: transitionOffer(changed, {
    type: "read_failed",
    stage: "version",
  }),
  gone: transitionOffer(ready, { type: "unavailable" }),
  retry_send: transitionOffer(sending, { type: "transport_failed" }),
  sent: transitionOffer(sending, { type: "send_succeeded" }),
};
const events: OfferEvent[] = [
  { type: "check_requested" },
  { type: "version_seen", offer: replacement },
  { type: "inventory_requested", version, side: "get" },
  { type: "inventory_received", version, side: "get", cards: [card] },
  { type: "inventory_obsolete", version },
  { type: "review_confirmed" },
  { type: "read_failed", stage: "version" },
  { type: "read_failed", stage: "inventory" },
  { type: "unavailable" },
  { type: "send_requested", terms: {}, key: "new" },
  { type: "offer_changed" },
  { type: "transport_failed" },
  { type: "send_refused" },
  { type: "send_succeeded" },
  { type: "retry" },
  { type: "draft_edited" },
];
// Each row corresponds to the events above, including both failure stages. No default/omitted pairs.
const table: Record<OfferPhase | "inventory_failed", OfferPhase[]> = {
  inventory_failed: [
    "checking",
    "changed",
    "read_failed",
    "read_failed",
    "checking",
    "read_failed",
    "read_failed",
    "read_failed",
    "gone",
    "read_failed",
    "checking",
    "read_failed",
    "read_failed",
    "read_failed",
    "loading",
    "read_failed",
  ],
  loading: [
    "checking",
    "changed",
    "loading",
    "loading",
    "checking",
    "loading",
    "read_failed",
    "read_failed",
    "gone",
    "loading",
    "checking",
    "loading",
    "loading",
    "loading",
    "loading",
    "loading",
  ],
  ready: [
    "checking",
    "changed",
    "loading",
    "ready",
    "checking",
    "ready",
    "read_failed",
    "read_failed",
    "gone",
    "sending",
    "checking",
    "ready",
    "ready",
    "ready",
    "ready",
    "ready",
  ],
  checking: [
    "checking",
    "changed",
    "checking",
    "checking",
    "checking",
    "checking",
    "read_failed",
    "checking",
    "gone",
    "checking",
    "checking",
    "checking",
    "checking",
    "checking",
    "checking",
    "checking",
  ],
  changed: [
    "checking",
    "changed",
    "changed",
    "changed",
    "changed",
    "loading",
    "read_failed",
    "changed",
    "gone",
    "changed",
    "checking",
    "changed",
    "changed",
    "changed",
    "changed",
    "changed",
  ],
  read_failed: [
    "checking",
    "changed",
    "read_failed",
    "read_failed",
    "read_failed",
    "loading",
    "read_failed",
    "read_failed",
    "gone",
    "read_failed",
    "checking",
    "read_failed",
    "read_failed",
    "read_failed",
    "checking",
    "read_failed",
  ],
  sending: [
    "sending",
    "sending",
    "sending",
    "sending",
    "sending",
    "sending",
    "sending",
    "sending",
    "gone",
    "sending",
    "checking",
    "retry_send",
    "ready",
    "sent",
    "sending",
    "sending",
  ],
  retry_send: [
    "retry_send",
    "retry_send",
    "retry_send",
    "retry_send",
    "retry_send",
    "retry_send",
    "retry_send",
    "retry_send",
    "gone",
    "sending",
    "checking",
    "retry_send",
    "retry_send",
    "retry_send",
    "retry_send",
    "ready",
  ],
  gone: Array(16).fill("gone"),
  sent: Array(16).fill("sent"),
};
for (const [phase, model] of Object.entries(states)) {
  events.forEach((event, index) =>
    it(`${phase} + ${event.type}${"stage" in event ? `/${event.stage}` : ""}`, () => {
      const next = transitionOffer(model, event);
      expect(table[phase as keyof typeof states]).toHaveLength(events.length);
      expect(next.phase).toBe(table[phase as keyof typeof states][index]);
      const controls = offerControls(next);
      // Back is rendered in every state. Recovery states also expose their concrete retry/review route.
      expect(controls.back).toBe(true);
      if (reviewRequired(next)) expect(controls.send).toBe(false);
      if (next.phase === "read_failed") expect(controls.retry).not.toBeNull();
      if (next.phase === "changed") expect(controls.review).toBe(true);
      if (next.phase === "sending") {
        expect(next.pending?.offer_id).toBe(next.reviewed.offer_id);
        expect(next.pending?.revision).toBe(next.reviewed.revision);
        expect(next.reviewed.offer_id).toBe(model.reviewed.offer_id);
      }
    })
  );
}
it("rejects obsolete inventory deliveries after review and never mixes old availability with new reservations", () => {
  expect(
    offerCaps(ready, counterProposal(original)).proposal.get[0].copies
  ).toBe("3");
  const confirmed = transitionOffer(changed, { type: "review_confirmed" });
  const stale = transitionOffer(confirmed, {
    type: "inventory_received",
    side: "get",
    version,
    cards: [{ ...card, copies: "2" }],
  });
  expect(stale).toBe(confirmed);
  expect(offerControls(stale).send).toBe(false);
  const freshVersion = offerVersion(replacement)!;
  const fresh = transitionOffer(
    transitionOffer(stale, {
      type: "inventory_received",
      side: "give",
      version: freshVersion,
      cards: [],
    }),
    {
      type: "inventory_received",
      side: "get",
      version: freshVersion,
      cards: [{ ...card, copies: "1" }],
    }
  );
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
it("retains byte-identical commands on unknown retry and clears the key only on explicit draft edit or known refusal", () => {
  const unknown = states.retry_send;
  const retried = transitionOffer(unknown, {
    type: "send_requested",
    terms: {},
    key: "different",
  });
  expect(retried.pending).toBe(sending.pending);
  expect(JSON.stringify(retried.pending)).toBe(JSON.stringify(sending.pending));
  expect(transitionOffer(unknown, { type: "draft_edited" }).pending).toBeNull();
  expect(transitionOffer(sending, { type: "send_refused" }).pending).toBeNull();
});
it("requires review even when an OFFER_CHANGED fresh read happens to return the same version", () => {
  const refused = transitionOffer(sending, { type: "offer_changed" });
  const read = transitionOffer(refused, {
    type: "version_seen",
    offer: original,
  });
  expect(read.phase).toBe("changed");
  expect(canSendOffer(read)).toBe(false);
});
it("failed replacement checks retain the candidate beside Retry and allow explicit review to recover", () => {
  expect(states.read_failed.candidate).toBe(replacement);
  expect(offerControls(states.read_failed)).toMatchObject({
    review: true,
    retry: "check",
    send: false,
  });
  expect(
    transitionOffer(states.read_failed, { type: "review_confirmed" }).reviewed
  ).toBe(replacement);
});

it.each(Object.keys(states))(
  "offers a bounded recovery route from %s through its rendered actions and successful reads",
  (name) => {
    const initial = states[name as keyof typeof states];
    if (initial.phase === "gone" || initial.phase === "sent") return;
    const seen = new Set<string>();
    const queue = [{ model: initial, depth: 0 }];
    let recovered = false;
    while (queue.length) {
      const { model, depth } = queue.shift()!;
      if (model.phase === "ready" || model.phase === "sent") {
        recovered = true;
        break;
      }
      if (depth >= 5) continue;
      const signature = [
        model.phase,
        model.reviewed.offer_id,
        !!model.candidate,
        model.failure,
        model.inventory.give !== null,
        model.inventory.get !== null,
      ].join("/");
      if (seen.has(signature)) continue;
      seen.add(signature);
      const controls = offerControls(model);
      const nextEvents: OfferEvent[] = [
        { type: "version_seen", offer: model.reviewed },
        {
          type: "inventory_received",
          version: offerVersion(model.reviewed)!,
          side: "give",
          cards: [],
        },
        {
          type: "inventory_received",
          version: offerVersion(model.reviewed)!,
          side: "get",
          cards: [card],
        },
      ];
      if (controls.review) nextEvents.push({ type: "review_confirmed" });
      if (controls.retry) nextEvents.push({ type: "retry" });
      if (controls.send)
        nextEvents.push({ type: "send_requested", terms: {}, key: "retry" });
      if (model.phase === "sending")
        nextEvents.push({ type: "send_succeeded" });
      for (const event of nextEvents)
        queue.push({ model: transitionOffer(model, event), depth: depth + 1 });
    }
    expect(recovered).toBe(true);
  }
);
