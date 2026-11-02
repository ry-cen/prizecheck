import { beforeEach, describe, expect, it } from "vitest";
import {
  OpenProposalProvider,
  clearProposalNotes,
  peekFromTradeList,
  peekProposalSeed,
  peekMatchProposal,
  proposeFromTradeList,
  proposeFromMatch,
  rekeyProposal,
} from "./openProposal";
import { seededProposal, type ProposalCard } from "./proposalModel";

const card: ProposalCard = {
  edition_id: "e1",
  name: "Arven",
  set_code: "SVI",
  set_name: "Scarlet & Violet",
  collector_number: "166",
  descriptor: {},
  image_url: null,
  copies: "2",
};

// Drives `open` without React: the provider is a plain function returning an element whose context value is `open`.
function openFn(): (handle: string, card?: ProposalCard) => void {
  const element = OpenProposalProvider({
    onNavigate: () => {},
    children: null,
  });
  return element.props.value;
}

describe("openProposal notes", () => {
  beforeEach(() => clearProposalNotes());

  it("peeking the seed twice returns the same proposal", () => {
    openFn()("Ash", card);
    rekeyProposal("ash", "t1");
    expect(peekProposalSeed("t1")).toEqual(seededProposal(card));
    expect(peekProposalSeed("t1")).toEqual(seededProposal(card));
  });

  it("a seed for another collector is not returned", () => {
    openFn()("Ash", card);
    rekeyProposal("Ash", "t1");
    expect(peekProposalSeed("t2")).toBeNull();
    expect(peekProposalSeed("t1")).toEqual(seededProposal(card));
  });

  it("clearing removes the seed and the origin", () => {
    openFn()("Ash", card);
    rekeyProposal("Ash", "t1");
    proposeFromTradeList("t1", "/back");
    clearProposalNotes();
    expect(peekProposalSeed("t1")).toBeNull();
    expect(peekFromTradeList("t1")).toBeNull();
  });

  it("a Trade List open drops a pending seed", () => {
    openFn()("Ash", card);
    rekeyProposal("Ash", "t1");
    proposeFromTradeList("t1", "/back");
    expect(peekProposalSeed("t1")).toBeNull();
    expect(peekFromTradeList("t1")).toBe("/back");
    expect(peekFromTradeList("t1")).toBe("/back");
  });

  it("Handle keys match case-insensitively", () => {
    openFn()("Ash", card);
    expect(peekProposalSeed("ASH")).toEqual(seededProposal(card));
  });
  it("a match uses the same keyed handoff and clears a prior Trade List origin", () => {
    proposeFromTradeList("t1", "/back");
    proposeFromMatch("t1", { you_get: [], you_give: [] });
    expect(peekProposalSeed("t1")).toEqual({ get: [], give: [] });
    expect(peekProposalSeed("t2")).toBeNull();
    expect(peekFromTradeList("t1")).toBeNull();
    expect(peekMatchProposal("t1")).toBe(true);
    expect(peekMatchProposal("t2")).toBe(false);
    clearProposalNotes();
    expect(peekMatchProposal("t1")).toBe(false);
    expect(peekProposalSeed("t1")).toBeNull();
  });
  it("an unseeded open drops a prior match, and Ask to trade still seeds exactly one copy", () => {
    proposeFromMatch("Ash", { you_get: [], you_give: [] });
    openFn()("Ash");
    expect(peekProposalSeed("Ash")).toBeNull();
    openFn()("Ash", card);
    expect(peekProposalSeed("Ash")?.get[0].quantity).toBe(1);
    expect(peekProposalSeed("Ash")?.give).toEqual([]);
  });
});
