import { describe, expect, it } from "vitest";
import type { LoanSide, LoanView, TradeView } from "../social_generated";
import type { OwnTradeSide } from "../trades_generated";
import {
  canKeepSwapChoices,
  canRetryHandover,
  canRetrySwap,
} from "../social/confirmationRetry";

const card = {
  edition_id: "iono",
  name: "Iono",
  set_code: "PAL",
  set_name: "Paldea",
  collector_number: "185",
  descriptor: {},
  image_url: null,
};
const trade: TradeView = {
  id: "trade",
  state: "accepted",
  closed_reason: null,
  closed_by: null,
  role: "proposer",
  other: {
    collector_id: "ash",
    handle: "ash",
    display_name: "Ash",
    open_to_cash_offers: true,
  },
  countered_from: null,
  you_give: [{ ...card, copies: "2" }],
  you_get: [{ ...card, edition_id: "arven", copies: "1" }],
  cash: { cents: "100", payer: "you" },
  you_confirmed_swap: false,
  they_confirmed_swap: false,
  needs_you: true,
  waiting: "confirm_swap",
  section: "to_swap",
  actions: ["confirm_swap"],
  revision: 4,
  created_at: "today",
};
const pick = {
  edition_id: "iono",
  location_id: "box",
  name: "Box",
  path: "Shelf / Box",
  copies: "2",
  short: "0",
};
const tradeSide: OwnTradeSide = {
  trade_id: "trade",
  picks: [pick],
  suggested: [],
  deck_switches: [],
};
const swapped = { ...trade, revision: 5, they_confirmed_swap: true };
const loan: LoanView = {
  id: "loan",
  kind: "borrow_request",
  state: "accepted",
  closed_reason: null,
  closed_by: null,
  role: "lender",
  other: { collector_id: "ash", handle: "ash", display_name: "Ash" },
  return_by: "2026-12-01",
  you_confirmed_handover: false,
  they_confirmed_handover: false,
  lines: [{ ...card, requested: "2", promised: "2", written_off: "0" }],
  needs_you: true,
  section: "needs_you",
  actions: ["confirm_handover"],
  revision: 4,
};
const loanSide: LoanSide = {
  loan_id: "loan",
  deck: null,
  can_promise: [],
  picks: [pick],
  suggested: [],
};
const handed = { ...loan, revision: 5, they_confirmed_handover: true };

describe("swap confirmation retry consent", () => {
  it("allows exactly the other side's first confirmation", () => {
    expect(canRetrySwap(trade, swapped, tradeSide, tradeSide)).toBe(true);
  });
  const changes: Partial<TradeView>[] = [
    { revision: 6 },
    { they_confirmed_swap: false },
    { you_confirmed_swap: true },
    { actions: [] },
    { state: "closed" },
    { cash: { cents: "200", payer: "you" } },
    { cash: { cents: "100", payer: "them" } },
    { you_give: [{ ...card, copies: "3" }] },
    { you_get: [{ ...card, copies: "1" }] },
    {
      you_give: [
        ...trade.you_give,
        { ...card, edition_id: "extra", copies: "1" },
      ],
    },
  ];
  it.each(changes)("refuses a change needing review: %j", (change) => {
    expect(
      canRetrySwap(trade, { ...swapped, ...change }, tradeSide, tradeSide)
    ).toBe(false);
  });
  it("refuses changed or short picks, including a fresh suggested pick", () => {
    for (const next of [
      { ...tradeSide, picks: [{ ...pick, location_id: "elsewhere" }] },
      { ...tradeSide, picks: [{ ...pick, path: "Other shelf / Box" }] },
      { ...tradeSide, picks: [{ ...pick, short: "1" }] },
      { ...tradeSide, suggested: [pick] },
    ])
      expect(canRetrySwap(trade, swapped, tradeSide, next)).toBe(false);
  });
  it("refuses an already observed confirmation or another collector", () => {
    expect(
      canRetrySwap(swapped, { ...swapped, revision: 6 }, tradeSide, tradeSide)
    ).toBe(false);
    expect(
      canRetrySwap(
        trade,
        { ...swapped, other: { ...trade.other, collector_id: "brock" } },
        tradeSide,
        tradeSide
      )
    ).toBe(false);
  });
});

describe("handover confirmation retry consent", () => {
  it("allows exactly the other side's first confirmation", () => {
    expect(canRetryHandover(loan, handed, loanSide, loanSide)).toBe(true);
  });
  const changes: Partial<LoanView>[] = [
    { revision: 6 },
    { they_confirmed_handover: false },
    { you_confirmed_handover: true },
    { actions: [] },
    { state: "closed" },
    { return_by: "2026-12-02" },
    { extension_to: "2026-12-03" },
    { lines: [{ ...loan.lines[0], promised: "1" }] },
    { lines: [{ ...loan.lines[0], edition_id: "arven" }] },
  ];
  it.each(changes)("refuses a change needing review: %j", (change) => {
    expect(
      canRetryHandover(loan, { ...handed, ...change }, loanSide, loanSide)
    ).toBe(false);
  });
  it("refuses a changed destination Deck or stale picks", () => {
    expect(
      canRetryHandover(loan, handed, loanSide, {
        ...loanSide,
        deck: { id: "deck", name: "Deck" },
      })
    ).toBe(false);
    expect(
      canRetryHandover(loan, handed, loanSide, {
        ...loanSide,
        suggested: [pick],
      })
    ).toBe(false);
    expect(
      canRetryHandover(loan, handed, loanSide, {
        ...loanSide,
        picks: [{ ...pick, path: "Other shelf / Box" }],
      })
    ).toBe(false);
  });
});

describe("swap choices after a revision conflict", () => {
  const place = {
    id: "deck",
    name: "Deck",
    kind: "deck",
    parent_id: null,
    version: 1,
    depth: 0,
    copy_count: "0",
    hidden: false,
    hidden_by: null,
    for_trade: false,
    for_trade_by: null,
  };
  const choice = {
    deck_id: "deck",
    from_edition_id: "iono",
    to_edition_id: "arven",
    count: "1",
  };
  const side = {
    ...tradeSide,
    deck_switches: [
      {
        ...choice,
        deck_name: "Deck",
        from_card: card,
        to_card: { ...card, edition_id: "arven" },
      },
    ],
  };
  it("preserves selected switches without adding unticked offers", () => {
    expect(canKeepSwapChoices(side, [place], "deck", [choice])).toBe(true);
    expect(canKeepSwapChoices(side, [], null, [])).toBe(true);
  });
  it("refuses a removed, converted, or non-leaf destination", () => {
    expect(canKeepSwapChoices(side, [], "deck", [])).toBe(false);
    expect(
      canKeepSwapChoices(side, [{ ...place, kind: "organization" }], "deck", [])
    ).toBe(false);
    expect(
      canKeepSwapChoices(
        side,
        [place, { ...place, id: "child", parent_id: "deck" }],
        "deck",
        []
      )
    ).toBe(false);
  });
  it("refuses a switch no longer offered or with a changed count", () => {
    expect(canKeepSwapChoices(tradeSide, [], null, [choice])).toBe(false);
    expect(
      canKeepSwapChoices(side, [], null, [{ ...choice, count: "2" }])
    ).toBe(false);
  });
});
