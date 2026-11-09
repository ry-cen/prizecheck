// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  getWantList,
  type WantList,
  type WantListLine,
} from "../want_list_generated";
import type { FriendCopy } from "../social_generated";
import { AskChip, AskControl } from "../loans/BorrowDrafts";
import { NeededLines, WantListView } from "./WantListView";
import { useBorrowMatches } from "./useBorrowMatches";
import type { PendingState } from "./pendingLoans";
import type { TradeWantsApi } from "./useTradeWants";

vi.mock("./useBorrowMatches", () => ({
  useBorrowMatches: vi.fn(() => answer),
}));
vi.mock("../want_list_generated", async (original) => ({
  ...(await original<typeof import("../want_list_generated")>()),
  getWantList: vi.fn(),
}));
vi.mock("../loans/BorrowDrafts", () => ({
  useBorrowDrafts: () => null,
  copyCard: (copy: FriendCopy, image_url: string | null) => ({
    ...copy,
    image_url,
  }),
  AskChip: vi.fn((props: Parameters<typeof AskChip>[0]) =>
    h("button", { "data-current": String(props.current) }, "Friend chip")
  ),
  AskControl: vi.fn((props: Parameters<typeof AskControl>[0]) =>
    h("button", { "data-current": String(props.current) }, "Friend ask")
  ),
}));
vi.mock("../workspace/media", () => ({
  MOBILE_QUERY: "phone",
  useMediaQuery: () => false,
}));
vi.mock("./useWantListSwap", () => ({ useWantListSwap: () => swap }));
vi.mock("./useTradeWants", () => ({ useTradeWants: () => trade }));
vi.mock("./WantListBuy", () => ({ WantListBuy: () => null }));
vi.mock("./SwapHint", () => ({ SwapHint: () => null }));
vi.mock("./TradeWantsPanel", () => ({
  TradeWantsPanel: () => null,
  TradeWantsShortcut: () => null,
  WillAcceptSelect: () => null,
  WillAcceptRadios: () => null,
}));
vi.mock("./WantListCost", async () => {
  const { createContext } = await import("react");
  return {
    WantListCostContext: createContext(null),
    useWantListCost: () => null,
    useTotalCostSuffix: () => "",
    CostSummary: () => null,
    LineCost: () => null,
    RowCost: () => null,
    SectionCost: () => null,
  };
});

const deck = "00000000-0000-4000-8000-000000000001";
const copy: FriendCopy = {
  collector_id: "misty",
  handle: "misty",
  display_name: "Misty",
  edition_id: "A",
  name: "Iono",
  set_code: "PAL",
  collector_number: "185",
  descriptor: {},
  other_printing: false,
  spare: "3",
  in_deck: "0",
};
const line: WantListLine = {
  edition_id: "A",
  name: "Iono",
  set_id: "PAL",
  set_name: "Paldea Evolved",
  collector_number: "185",
  descriptor: {},
  image_url: null,
  quantity: "3",
  held: "0",
  spare: "0",
  other_decks: "0",
  counted_from: [],
  lent: "0",
  borrowed: "0",
  owned: "0",
  need: "3",
};
const section = {
  deck_id: deck,
  name: "Charizard",
  deck_list_revision: 1,
  to_get: "3",
  lines: [line],
};
const list: WantList = {
  deck_id: deck,
  want_list_counting: "all_at_once",
  settings_revision: 1,
  owner_revision: 1,
  deck_lists_digest: "pins",
  decks: [{ id: deck, name: "Charizard" }],
  sections: [section],
  combined: [{ ...line, decks: [{ deck_id: deck, need: "3" }] }],
  to_get: "3",
};
const swap = { busy: false, swap: vi.fn() };
const trade: TradeWantsApi = {
  state: { kind: "loading" },
  busy: false,
  refusal: "",
  clearRefusal: vi.fn(),
  setQuantity: async () => false,
  pendingRule: null,
  setRule: vi.fn(),
  retry: vi.fn(),
};
function ready(stale = false): Extract<PendingState, { kind: "ready" }> {
  return {
    kind: "ready",
    deckId: deck,
    stale,
    lines: new Map([
      [
        "A",
        {
          edition_id: "A",
          requested: "1",
          accepted: "0",
          lenders: [
            {
              lender_id: "misty",
              lender: "Misty",
              state: "requested",
              copies: "1",
            },
          ],
        },
      ],
    ]),
  };
}
function response(
  pending: boolean,
  state: PendingState = ready()
): ReturnType<typeof useBorrowMatches> {
  return {
    friends: {
      kind: "ready",
      hasFriends: true,
      pending,
      byCard: new Map([["A", [copy]]]),
    },
    pending: { state, retry: vi.fn() },
  };
}
let answer: ReturnType<typeof useBorrowMatches>;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  window.history.replaceState(null, "", `/decks/want-list?deck=${deck}`);
  vi.mocked(getWantList).mockResolvedValue(list);
  answer = response(false);
});
afterEach(() => vi.unstubAllGlobals());
const cases: {
  name: string;
  pending: boolean;
  state: () => PendingState;
  current: boolean;
}[] = [
  {
    name: "current answer",
    pending: false,
    state: () => ready(),
    current: true,
  },
  {
    name: "same-Deck refresh",
    pending: true,
    state: () => ready(),
    current: false,
  },
  {
    name: "unknown coverage",
    pending: false,
    state: () => ({ kind: "loading", deckId: deck }),
    current: false,
  },
  {
    name: "failed coverage",
    pending: false,
    state: () => ({ kind: "failed", deckId: deck }),
    current: false,
  },
  {
    name: "stale coverage",
    pending: false,
    state: () => ready(true),
    current: false,
  },
];
function friendsView(host: HTMLElement) {
  return Array.from(
    host.querySelectorAll<HTMLButtonElement>('[role="radio"]')
  ).find((button) => button.textContent === "Get from Friends")!;
}

it.each(cases)(
  "WantListView passes $current to both borrowing controls for $name",
  async (test) => {
    answer = response(test.pending, test.state());
    const host = document.createElement("div"),
      root = createRoot(host);
    try {
      await act(async () =>
        root.render(
          h(WantListView, { onOpenDeck: vi.fn(), onNavigate: vi.fn() })
        )
      );
      expect(AskChip).toHaveBeenCalled();
      expect(vi.mocked(AskChip).mock.calls.at(-1)![0]).toMatchObject({
        current: test.current,
        deckId: deck,
      });
      expect(
        host.querySelector("[data-current]")?.getAttribute("data-current")
      ).toBe(String(test.current));
      await act(async () => friendsView(host).click());
      expect(AskControl).toHaveBeenCalled();
      expect(vi.mocked(AskControl).mock.calls.at(-1)![0]).toMatchObject({
        current: test.current,
        deckId: deck,
      });
      expect(
        host.querySelector("[data-current]")?.getAttribute("data-current")
      ).toBe(String(test.current));
    } finally {
      await act(async () => root.unmount());
    }
  }
);

it.each([
  ...cases,
  {
    name: "another Deck's coverage",
    pending: false,
    state: () => ({ ...ready(), deckId: "other" }),
    current: false,
  },
])("NeededLines passes $current to its chip for $name", async (test) => {
  const host = document.createElement("div"),
    root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        h(NeededLines, {
          section,
          deckName: () => "Charizard",
          swap,
          trade,
          borrowFor: deck,
          byCard: new Map([["A", [copy]]]),
          borrowReady: !test.pending,
          pending: { state: test.state(), retry: vi.fn() },
        })
      )
    );
    expect(AskChip).toHaveBeenCalled();
    expect(vi.mocked(AskChip).mock.calls.at(-1)![0]).toMatchObject({
      current: test.current,
      deckId: deck,
    });
    expect(
      host.querySelector("[data-current]")?.getAttribute("data-current")
    ).toBe(String(test.current));
  } finally {
    await act(async () => root.unmount());
  }
});

it("keeps the Get from Friends introduction mounted while the same Deck refreshes", async () => {
  const host = document.createElement("div"),
    root = createRoot(host);
  const render = () =>
    root.render(h(WantListView, { onOpenDeck: vi.fn(), onNavigate: vi.fn() }));
  const introduction = () =>
    Array.from(host.querySelectorAll("p")).find(
      (p) => p.textContent === "Cards you need that Friends can lend."
    );
  try {
    answer = {
      friends: { kind: "none" },
      pending: { state: { kind: "loading", deckId: deck }, retry: vi.fn() },
    };
    await act(async () => render());
    expect(introduction()).toBeUndefined();
    answer = response(false);
    await act(async () => render());
    await act(async () => friendsView(host).click());
    const paragraph = introduction();
    expect(paragraph).toBeDefined();
    answer = response(true);
    await act(async () => render());
    expect(introduction()).toBe(paragraph);
    expect(vi.mocked(AskControl).mock.calls.at(-1)![0].current).toBe(false);
    answer = response(true, ready(true));
    await act(async () => render());
    expect(introduction()).toBe(paragraph);
    answer = response(false);
    await act(async () => render());
    expect(introduction()).toBe(paragraph);
    expect(vi.mocked(AskControl).mock.calls.at(-1)![0].current).toBe(true);
  } finally {
    await act(async () => root.unmount());
  }
});
