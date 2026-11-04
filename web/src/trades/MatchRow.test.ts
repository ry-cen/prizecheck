// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { TradeMatchRow } from "../social_generated";
import { MatchRow } from "./MatchRow";
import {
  peekProposalSeed,
  peekMatchProposal,
  clearProposalNotes,
} from "./openProposal";
const row: TradeMatchRow = {
  collector_id: "friend",
  trader_id: "trader",
  handle: "misty",
  display_name: "Misty",
  completed_trades: 0,
  open_to_cash_offers: false,
  match: "has_what_you_want",
  you_give: [],
  you_get: [
    {
      edition_id: "iono",
      name: "Iono",
      set_code: "PAL",
      set_name: "Paldea Evolved",
      collector_number: "185",
      descriptor: {},
      image_url: null,
      copies: "1",
      need: "1",
      want_list_need: "1",
      origin: "want_list",
      accepts_as: "exact",
      need_groups: ["need"],
    },
  ],
  more_you_get: 0,
  more_you_give: 0,
  you_get_groups: [{ id: "need", need: "1", cards: "1" }],
  you_give_groups: [],
};
it.each([false, true])(
  "offers exactly one match-prefilled proposal action with the row open=%s",
  async (open) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host),
      navigate = vi.fn();
    try {
      await act(async () =>
        root.render(
          h(MatchRow, {
            row,
            handle: "misty",
            band: null,
            tradeListPath: "/friends/misty/trade-list",
            loadAll: async () => row,
            open,
            onToggle: vi.fn(),
            onNavigate: navigate,
          })
        )
      );
      const proposals = [...host.querySelectorAll("button")].filter(
        (node) => node.textContent === "Propose trade"
      );
      expect(proposals).toHaveLength(1);
      await act(async () => proposals[0].click());
      expect(navigate).toHaveBeenCalledWith("/trades/new/trader");
      expect(peekMatchProposal("trader")).toBe(true);
      expect(
        peekProposalSeed("trader")?.get.map((line) => line.edition_id)
      ).toEqual(["iono"]);
    } finally {
      await act(async () => root.unmount());
      host.remove();
      vi.unstubAllGlobals();
      clearProposalNotes();
    }
  }
);
