import { describe, expect, it } from "vitest";
import type { TradeMatchCard } from "../social_generated";
import {
  matchedProposal,
  chooseMatchedPrinting,
  setQuantity,
} from "./proposalModel";

type Group = { id: string; need: string; cards: string };
type MatchCard = TradeMatchCard & { need_groups: string[] };
function card(edition_id: string, groups: string[], copies = "4"): MatchCard {
  return {
    edition_id,
    name: "Iono",
    set_code: "PAL",
    set_name: "Paldea Evolved",
    collector_number: "185",
    descriptor: {},
    image_url: null,
    copies,
    need: "99",
    want_list_need: "99",
    origin: "both",
    accepts_as: "exact",
    need_groups: groups,
  };
}
function row(
  you_get: MatchCard[],
  you_get_groups: Group[],
  you_give: MatchCard[] = [],
  you_give_groups: Group[] = []
) {
  return { you_get, you_get_groups, you_give, you_give_groups };
}
const shared: Group = { id: "shared", need: "2", cards: "2" };
const exact: Group = { id: "exact", need: "1", cards: "1" };

describe("need-group match prefill", () => {
  it("does not choose between printings of one widened want, even when one is exact", () => {
    const source = row(
      [
        card("pal", ["shared"]),
        { ...card("paf", ["shared"]), accepts_as: "same_name" },
      ],
      [shared]
    );
    expect(matchedProposal(source)).toEqual({ get: [], give: [] });
  });
  it("prefills only an unambiguous exact Trade Wants part overlapping a widened want", () => {
    const source = row(
      [card("pal", ["shared"]), card("paf", ["shared", "exact"])],
      [shared, exact]
    );
    expect(
      matchedProposal(source).get.map((line) => [
        line.edition_id,
        line.quantity,
      ])
    ).toEqual([["paf", 1]]);
  });
  it("sums two unambiguous wanted parts on one card, then caps by availability", () => {
    const source = row(
      [card("pal", ["one", "two"], "2")],
      [
        { id: "one", need: "2", cards: "1" },
        { id: "two", need: "3", cards: "1" },
      ]
    );
    expect(matchedProposal(source).get[0].quantity).toBe(2);
    expect(matchedProposal(source).get[0].copies).toBe("2");
  });
  it("caps a single unambiguous want by offered copies", () => {
    expect(
      matchedProposal(
        row([card("pal", ["g"], "1")], [{ id: "g", need: "5", cards: "1" }])
      ).get[0].quantity
    ).toBe(1);
  });
  it("does not treat a truncated group's one carried member as unambiguous", () => {
    expect(
      matchedProposal(row([card("visible", ["shared"])], [shared]))
    ).toEqual({ get: [], give: [] });
  });
  it("copies only card facts and quantities into draft lines", () => {
    const line = matchedProposal(row([card("pal", ["exact"])], [exact])).get[0];
    expect(line).not.toHaveProperty("need_groups");
    expect(line).not.toHaveProperty("need");
    expect(line).not.toHaveProperty("want_list_need");
  });
  it("never falls back to per-card need when group lists are missing", () => {
    expect(
      matchedProposal({ you_get: [card("pal", ["exact"])], you_give: [] })
    ).toEqual({ get: [], give: [] });
  });
  it("uses the same mapping on You give, without changing side or choosing by price or order", () => {
    const source = row([], [], [card("pal", ["exact"])], [exact]);
    expect(
      matchedProposal(source).give.map((line) => [
        line.edition_id,
        line.quantity,
      ])
    ).toEqual([["pal", 1]]);
    expect(matchedProposal(source).get).toEqual([]);
  });
  it("requires referenced group ids to exist in this response", () => {
    expect(
      matchedProposal(row([card("pal", ["from-another-response"])], [exact]))
    ).toEqual({ get: [], give: [] });
  });
  it("does not invent counts for invalid groups", () => {
    expect(
      matchedProposal(
        row([card("pal", ["g"])], [{ id: "g", need: "unknown", cards: "1" }])
      )
    ).toEqual({ get: [], give: [] });
  });
});

describe("explicit printing choice", () => {
  const source = row(
    [card("pal", ["shared"], "1"), card("paf", ["shared"], "4")],
    [shared]
  );
  it("adds only the chosen printing, capped by copies and remaining group need", () => {
    const chosen = chooseMatchedPrinting(
      matchedProposal(source),
      "get",
      source,
      "shared",
      "pal"
    );
    expect(chosen.get.map((line) => [line.edition_id, line.quantity])).toEqual([
      ["pal", 1],
    ]);
    const rest = chooseMatchedPrinting(chosen, "get", source, "shared", "paf");
    expect(rest.get.map((line) => [line.edition_id, line.quantity])).toEqual([
      ["pal", 1],
      ["paf", 1],
    ]);
    expect(chooseMatchedPrinting(rest, "get", source, "shared", "paf")).toEqual(
      rest
    );
  });
  it("counts manually added copies and makes room again when they are removed", () => {
    const manually = setQuantity(
      matchedProposal(source),
      "get",
      source.you_get[1],
      2
    );
    expect(
      chooseMatchedPrinting(manually, "get", source, "shared", "pal")
    ).toEqual(manually);
    const removed = setQuantity(manually, "get", source.you_get[1], 0);
    expect(
      chooseMatchedPrinting(removed, "get", source, "shared", "paf").get[0]
        .quantity
    ).toBe(2);
  });
  it("counts an unambiguous overlapping group's prefill toward the shared total", () => {
    const overlap = row(
      [card("pal", ["shared"]), card("paf", ["shared", "exact"])],
      [shared, exact]
    );
    const chosen = chooseMatchedPrinting(
      matchedProposal(overlap),
      "get",
      overlap,
      "shared",
      "pal"
    );
    expect(chosen.get.map((line) => [line.edition_id, line.quantity])).toEqual([
      ["paf", 1],
      ["pal", 1],
    ]);
  });
  it("applies an explicit choice to You give with its own response-local group", () => {
    const giving = row([], [], source.you_get, source.you_get_groups);
    const chosen = chooseMatchedPrinting(
      matchedProposal(giving),
      "give",
      giving,
      "shared",
      "paf"
    );
    expect(chosen.get).toEqual([]);
    expect(chosen.give.map((line) => [line.edition_id, line.quantity])).toEqual(
      [["paf", 2]]
    );
  });

  it("cannot select a non-member or reuse another response's id", () => {
    const empty = matchedProposal(source);
    expect(
      chooseMatchedPrinting(empty, "get", source, "shared", "other")
    ).toEqual(empty);
    expect(
      chooseMatchedPrinting(empty, "get", source, "old-id", "pal")
    ).toEqual(empty);
  });
  it("keeps the existing one-side-only rule", () => {
    const other = setQuantity(
      matchedProposal(source),
      "give",
      source.you_get[0],
      1
    );
    expect(
      chooseMatchedPrinting(other, "get", source, "shared", "pal")
    ).toEqual(other);
  });
});
