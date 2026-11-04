import { expect, it, vi } from "vitest";
import { SocialError, type TradeView } from "../social_generated";
import { TradesError } from "../trades_generated";
import { OfferReview, offerChanges } from "./offerReview";
import {
  threadVersionChanged,
  sameLoanTermsVersion,
} from "../threads/commandChanges";
import { tradeStepMessage } from "./tradeText";
import { loanStepMessage } from "../loans/loanText";
const offeredCard = (edition_id: string, name: string) => ({
  edition_id,
  name,
  copies: "1",
  set_code: "PAL",
  set_name: "Paldea",
  collector_number: "1",
  descriptor: { finish: "normal" },
  image_url: null,
});
function loadedInventory(review: OfferReview) {
  for (const side of ["give", "get"] as const)
    review.dispatch({
      type: "inventory_received",
      version: `${review.reviewed.thread_id}/${review.reviewed.offer_id}/${review.reviewed.revision}`,
      side,
      cards: review.reviewed[side === "give" ? "you_give" : "you_get"].map(
        (card) => ({ ...card, copies: "3" })
      ),
    });
}
function loadedReview(offer: TradeView) {
  const review = new OfferReview(offer);
  loadedInventory(review);
  return review;
}
const original: TradeView = {
  id: "old",
  offer_id: "old",
  thread_id: "item",
  state: "proposed",
  closed_reason: null,
  closed_by: null,
  role: "recipient",
  other: {
    collector_id: null,
    handle: null,
    display_name: "Ash",
    open_to_cash_offers: false,
  },
  countered_from: null,
  you_give: [offeredCard("own", "Iono")],
  you_get: [offeredCard("other", "Arven")],
  cash: null,
  you_confirmed_swap: false,
  they_confirmed_swap: false,
  needs_you: true,
  waiting: "answer",
  section: "needs_you",
  actions: ["counter"],
  revision: 2,
  created_at: "2026-11-04T00:00:00Z",
};
it.each(["counter", "change_offer"] as const)(
  "keeps the draft and requires review after a peer replaces an offer during %s",
  async (action) => {
    const review = loadedReview({ ...original, actions: [action] });
    const fresh = {
      ...original,
      id: "new",
      offer_id: "new",
      revision: 1,
      cash: { cents: "500", payer: "them" as const },
      actions: [action],
    };
    const post = vi
      .fn()
      .mockRejectedValueOnce(new TradesError(409, "OFFER_CHANGED"))
      .mockResolvedValue(fresh);
    const read = vi.fn().mockResolvedValue(fresh);
    const draft = {
      you_give: [{ edition_id: "own", quantity: "1" }],
      you_get: [{ edition_id: "other", quantity: "1" }],
      cash: { cents: "900", payer: "you" as const },
    };
    expect(await review.submit(draft, "old-key", post, read)).toBeNull();
    expect(read).toHaveBeenCalledWith("item");
    expect(review.required).toBe(true);
    expect(review.candidate).toEqual(fresh);
    expect(offerChanges(review.reviewed, fresh)).toContain(
      "Cash: no cash; now they pay $5.00."
    );
    expect(await review.submit(draft, "new-key", post, read)).toBeNull();
    expect(post).toHaveBeenCalledTimes(1);
    expect(review.confirm()).toBe(true);
    loadedInventory(review);
    await review.submit(draft, "new-key", post, read);
    expect(post.mock.calls[1][1]).toEqual({
      ...draft,
      offer_id: "new",
      revision: 1,
      idempotency_key: "new-key",
    });
    expect(draft.cash.cents).toBe("900");
  }
);
it("fails closed when the fresh read fails and never sends to the obsolete offer again", async () => {
  const review = loadedReview(original);
  const post = vi.fn().mockRejectedValue(new TradesError(409, "OFFER_CHANGED"));
  await expect(
    review.submit({}, "key", post, async () => {
      throw new Error("Offline");
    })
  ).rejects.toThrow("Offline");
  expect(review.required).toBe(true);
  expect(review.confirm()).toBe(false);
  expect(await review.submit({}, "other-key", post, vi.fn())).toBeNull();
  expect(post).toHaveBeenCalledTimes(1);
});
it("keeps unknown-outcome retries on the same reviewed identity and key", async () => {
  const review = loadedReview(original);
  const post = vi
    .fn()
    .mockRejectedValueOnce(new TypeError("Offline"))
    .mockResolvedValue(original);
  const read = vi.fn();
  await expect(review.submit({}, "key", post, read)).rejects.toThrow("Offline");
  await review.submit({}, "key", post, read);
  expect(post.mock.calls[1]).toEqual(post.mock.calls[0]);
  expect(read).not.toHaveBeenCalled();
});
it("classifies stale detail commands and gives plain words for Trade and Loan consumers", () => {
  expect(threadVersionChanged("OFFER_CHANGED")).toBe(true);
  expect(threadVersionChanged("LOAN_CHANGED")).toBe(true);
  expect(threadVersionChanged("INVENTORY_TEMPORARILY_UNAVAILABLE")).toBe(false);
  expect(
    tradeStepMessage(new TradesError(409, "OFFER_CHANGED"), original)
  ).toBe(
    "The offer changed. Review the current cards and cash before trying again."
  );
  expect(
    loanStepMessage(new SocialError(409, "OFFER_CHANGED"), "Ash", () => "")
  ).toBe(
    "The Loan terms changed. Review the current terms before trying again."
  );
});

it("stops posting when the thread can no longer be found", async () => {
  const review = loadedReview(original),
    post = vi.fn().mockRejectedValue(new TradesError(404, "TRADE_NOT_FOUND"));
  expect(await review.submit({}, "key", post, vi.fn())).toBeNull();
  expect(review.unavailable).toBe(true);
  expect(await review.submit({}, "again", post, vi.fn())).toBeNull();
  expect(post).toHaveBeenCalledTimes(1);
});

it("keeps a Loan terms editor bound to its opened round and revision", () => {
  const opened = { loan_id: "old-round", revision: 2 };
  const current = {
    ...opened,
    state: "requested",
    actions: ["edit_and_resend"],
  };
  expect(sameLoanTermsVersion(opened, current)).toBe(true);
  expect(
    sameLoanTermsVersion(opened, {
      ...current,
      loan_id: "peer-replacement",
      revision: 1,
    })
  ).toBe(false);
  expect(sameLoanTermsVersion(opened, { ...current, revision: 3 })).toBe(false);
  expect(
    sameLoanTermsVersion(opened, { ...current, state: "accepted", actions: [] })
  ).toBe(false);
});

it("names changed quantities and the new agreement state in plain words", () => {
  const card = {
    edition_id: "private-edition-id",
    copies: "1",
    name: "Iono",
    set_code: "PAL",
    set_name: "Paldea",
    collector_number: "1",
    descriptor: { finish: "normal" },
    image_url: null,
  };
  const before = { ...original, you_get: [card] };
  const after = {
    ...original,
    state: "accepted" as const,
    you_get: [{ ...card, copies: "2" }],
  };
  expect(offerChanges(before, after)).toEqual([
    "You get Iono (PAL 1): 1 before, 2 now.",
    "The Trade is now agreed.",
  ]);
  expect(offerChanges(before, after).join(" ")).not.toContain(
    "private-edition-id"
  );
});
