import { expect, it, vi } from "vitest";
import type { TradeCard, TradeView } from "../social_generated";
import { counterProposal } from "./proposalModel";
import { OfferReview } from "./offerReview";
import { offerLibrary } from "./offerCopies";
import {
  currentOfferRead,
  OfferInventoryChanged,
  offerVersion,
  readOfferInventory,
  selectedOfferInventory,
  withOfferInventoryCaps,
} from "./offerInventory";

const card = (edition_id: string, copies: string): TradeCard => ({
  edition_id,
  copies,
  name: edition_id,
  set_code: "PAL",
  set_name: "Paldea",
  collector_number: "1",
  descriptor: {},
  image_url: null,
});
type InventoryOffer = TradeView;
const offer: InventoryOffer = {
  id: "original",
  closed_reason: null,
  closed_by: null,
  other: {
    collector_id: null,
    handle: null,
    display_name: "Ash",
    open_to_cash_offers: false,
  },
  countered_from: null,
  cash: null,
  you_confirmed_swap: false,
  they_confirmed_swap: false,
  needs_you: true,
  waiting: "answer",
  section: "needs_you",
  actions: ["counter"],
  created_at: "2026-11-04T00:00:00Z",
  thread_id: "thread",
  offer_id: "original",
  revision: 1,
  state: "proposed",
  role: "recipient",
  you_give: [card("own", "1")],
  you_get: [card("other", "1")],
};

it.each([
  ["proposed", "recipient", "get"],
  ["proposed", "proposer", "give"],
  ["accepted", "recipient", "get"],
  ["accepted", "proposer", "give"],
] as const)(
  "keeps stock three after reviewing a changed %s %s offer on %s",
  async (state, role, side) => {
    const original = { ...offer, state, role };
    const review = new OfferReview(original);
    const replacement = {
      ...original,
      id: "replacement",
      offer_id: "replacement",
      revision: 2,
      you_give: [card("own", "2")],
      you_get: [card("other", "2")],
    };
    const edition = side === "give" ? "own" : "other";
    const oldRead = await readOfferInventory(
      original,
      async () => [card(edition, "2")],
      async () => original
    );
    const ready = {
      kind: "ready" as const,
      cards: oldRead.value,
      offerVersion: oldRead.offerVersion,
    };
    let draft = counterProposal(original);
    const project = (cards: TradeCard[], reviewed: InventoryOffer) => {
      const library = offerLibrary(cards, reviewed, side);
      return withOfferInventoryCaps(
        draft,
        side === "give" ? library : [],
        side === "get" ? library : []
      );
    };
    draft = project(ready.cards, original);
    expect(draft[side][0].copies).toBe("3");
    // Explicit review adopts a different offer before the inventory effects have run.
    // Old available=2 plus replacement reserved=2 must never produce cap=4.
    await review.refresh(async () => replacement);
    expect(review.required).toBe(true);
    expect(review.confirm()).toBe(true);
    expect(currentOfferRead(ready, review.reviewed)).toEqual({
      kind: "loading",
    });
    expect(draft[side][0].copies).toBe("3");
    const fresh = await readOfferInventory(
      replacement,
      async () => [card(edition, "1")],
      async () => replacement
    );
    const next = currentOfferRead(
      { ...ready, cards: fresh.value, offerVersion: fresh.offerVersion },
      replacement
    );
    expect(next.kind).toBe("ready");
    if (next.kind !== "ready") throw new Error("Expected matching inventory");
    // Also remove a cap retained from a previous read; never trim the collector's draft.
    draft = {
      ...draft,
      [side]: [{ ...draft[side][0], copies: "4", quantity: 4 }],
    };
    draft = project(next.cards, replacement);
    expect(draft[side][0].copies).toBe("3");
    expect(draft[side][0].quantity).toBe(4);
    expect(draft[side][0].quantity).toBeGreaterThan(
      Number(draft[side][0].copies)
    );
  }
);

it("invalidates inventory on an in-place offer revision as well as replacement", () => {
  const ready = { kind: "ready", offerVersion: offerVersion(offer), cards: [] };
  expect(currentOfferRead(ready, offer)).toBe(ready);
  expect(currentOfferRead(ready, { ...offer, revision: 2 })).toEqual({
    kind: "loading",
  });
});

it("refuses an inventory read when the offer already changed, without fetching inventory", async () => {
  const read = vi.fn();
  await expect(
    readOfferInventory(offer, read, async () => ({ ...offer, offer_id: "new" }))
  ).rejects.toBeInstanceOf(OfferInventoryChanged);
  expect(read).not.toHaveBeenCalled();
});

it("discards a response when the offer changes while inventory is in flight", async () => {
  let current = offer;
  await expect(
    readOfferInventory(
      offer,
      async () => {
        current = { ...offer, offer_id: "new", revision: 2 };
        return [card("other", "1")];
      },
      async () => current
    )
  ).rejects.toBeInstanceOf(OfferInventoryChanged);
});

it("does not fetch an offer for a new proposal with no reservations", async () => {
  const readOffer = vi.fn();
  const result = await readOfferInventory(
    undefined,
    async () => [card("own", "3")],
    readOffer
  );
  expect(result.value[0].copies).toBe("3");
  expect(currentOfferRead({ kind: "ready", ...result }, undefined).kind).toBe(
    "ready"
  );
  expect(readOffer).not.toHaveBeenCalled();
});

it("sets missing Editions to zero without deleting draft lines or quantities", () => {
  const draft = counterProposal(offer);
  const projected = withOfferInventoryCaps(draft, [], []);
  expect(projected.get[0].copies).toBe("0");
  expect(projected.get[0].quantity).toBe(1);
  expect(projected.give[0].copies).toBe("0");
  expect(projected.give[0].quantity).toBe(1);
});

it("reads selected Editions beyond the visible page without a library search", async () => {
  const pages = vi.fn(async (page?: number) =>
    page === 2
      ? { cards: [card("selected", "1")], next_page: 3 }
      : { cards: [card("unrelated", "10")], next_page: 2 }
  );
  expect(await selectedOfferInventory(["selected"], pages)).toEqual([
    card("selected", "1"),
  ]);
  expect(pages.mock.calls).toEqual([[undefined], [2]]);
});
it("does not load pages for a cash-only side and exhausts pages for unavailable Editions", async () => {
  const pages = vi.fn(async () => ({
    cards: [card("unrelated", "10")],
    next_page: null,
  }));
  expect(await selectedOfferInventory([], pages)).toEqual([]);
  expect(pages).not.toHaveBeenCalled();
  expect(await selectedOfferInventory(["missing"], pages)).toEqual([]);
  expect(pages).toHaveBeenCalledTimes(1);
});
