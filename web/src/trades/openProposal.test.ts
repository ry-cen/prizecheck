import { beforeEach, describe, expect, it } from "vitest";
import {
  OpenProposalProvider,
  clearProposalNotes,
  peekFromTradeList,
  peekProposalSeed,
  proposeFromTradeList,
  rekeyProposal,
} from "./openProposal";
import { toProposalCard, type ProposalCard } from "./proposalModel";

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

  it("peeking the seed twice returns the same card", () => {
    openFn()("Ash", card);
    rekeyProposal("ash", "t1");
    expect(peekProposalSeed("t1")).toEqual(toProposalCard(card));
    expect(peekProposalSeed("t1")).toEqual(toProposalCard(card));
  });

  it("a seed for another collector is not returned", () => {
    openFn()("Ash", card);
    rekeyProposal("Ash", "t1");
    expect(peekProposalSeed("t2")).toBeNull();
    expect(peekProposalSeed("t1")).toEqual(toProposalCard(card));
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
    expect(peekProposalSeed("ASH")).toEqual(toProposalCard(card));
  });
});
