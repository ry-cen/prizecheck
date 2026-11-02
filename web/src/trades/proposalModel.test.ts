import { describe, expect, it } from "vitest";
import type { TradeMatchCard } from "../social_generated";
import { matchedProposal } from "./proposalModel";

function card(edition_id: string, copies = "4", need = "2"): TradeMatchCard {
  return {
    edition_id,
    name: "Arven",
    set_code: "SVI",
    set_name: "Scarlet & Violet",
    collector_number: "166",
    descriptor: {},
    image_url: null,
    copies,
    need,
    want_list_need: "1",
    origin: "both",
    accepts_as: "exact",
  };
}

describe("a proposal from the visible match", () => {
  it("puts the shown cards on their respective sides, bounded by availability and total need", () => {
    const row = {
      you_get: [card("get", "2", "3")],
      you_give: [card("give", "5", "2")],
    };
    const proposal = matchedProposal(row);
    expect(
      proposal.get.map(({ edition_id, quantity, copies }) => ({
        edition_id,
        quantity,
        copies,
      }))
    ).toEqual([{ edition_id: "get", quantity: 2, copies: "2" }]);
    expect(
      proposal.give.map(({ edition_id, quantity, copies }) => ({
        edition_id,
        quantity,
        copies,
      }))
    ).toEqual([{ edition_id: "give", quantity: 2, copies: "5" }]);
    expect(row.you_give[0].copies).toBe("5");
  });

  it("uses total need, including Trade Wants, without adding the Want List portion twice", () => {
    expect(
      matchedProposal({ you_get: [card("get", "8", "3")], you_give: [] }).get[0]
        .quantity
    ).toBe(3);
  });

  it("copies only proposal card facts, without match metadata", () => {
    expect(
      matchedProposal({ you_get: [card("get")], you_give: [] }).get[0]
    ).toEqual({
      edition_id: "get",
      name: "Arven",
      set_code: "SVI",
      set_name: "Scarlet & Violet",
      collector_number: "166",
      descriptor: {},
      image_url: null,
      copies: "4",
      quantity: 2,
    });
  });

  it("does not fetch or fabricate cards beyond the visible arrays", () => {
    const row = {
      you_get: [card("visible")],
      you_give: [],
      more_you_get: 9,
      more_you_give: 5,
    };
    expect(matchedProposal(row).get.map((line) => line.edition_id)).toEqual([
      "visible",
    ]);
    expect(matchedProposal(row).give).toEqual([]);
  });

  it("supports either one-way match and an empty match", () => {
    expect(
      matchedProposal({ you_get: [], you_give: [card("give")] }).give[0]
        .quantity
    ).toBe(2);
    expect(matchedProposal({ you_get: [], you_give: [] })).toEqual({
      get: [],
      give: [],
    });
  });

  it("does not add unavailable or no-longer-wanted copies", () => {
    expect(
      matchedProposal({
        you_get: [card("unavailable", "0"), card("not-wanted", "4", "0")],
        you_give: [],
      })
    ).toEqual({ get: [], give: [] });
  });

  it("never invents a quantity when either match count is unusable", () => {
    expect(
      matchedProposal({
        you_get: [
          card("no-need", "4", ""),
          card("unknown-copies", "unknown", "2"),
        ],
        you_give: [],
      })
    ).toEqual({ get: [], give: [] });
  });

  it("keeps the existing one-side-only rule when an Edition is matched both ways", () => {
    const proposal = matchedProposal({
      you_get: [card("same")],
      you_give: [card("same")],
    });
    expect(proposal.get).toHaveLength(1);
    expect(proposal.give).toEqual([]);
  });
});
