import { expect, it } from "vitest";
import { proposalDraftChanged } from "./ProposalBuilderPage";
import { EMPTY_PROPOSAL, NO_CASH, type ProposalLine } from "./proposalModel";
const card = (edition_id: string, quantity: number): ProposalLine => ({
  edition_id,
  quantity,
  name: "Switch",
  set_code: "MEG",
  set_name: "Mega Evolution",
  collector_number: "130",
  descriptor: {},
  image_url: null,
  copies: "8",
});
const opening = { get: [card("a", 1), card("b", 2)], give: [] };
it("compares semantic cards and cash with the opening draft", () => {
  expect(
    proposalDraftChanged(EMPTY_PROPOSAL, NO_CASH, EMPTY_PROPOSAL, {
      payer: "you",
      amount: "5",
    })
  ).toBe(true);
  expect(proposalDraftChanged(opening, NO_CASH, EMPTY_PROPOSAL, NO_CASH)).toBe(
    true
  );
  expect(
    proposalDraftChanged(
      opening,
      NO_CASH,
      { get: [card("b", 2), card("a", 1), card("c", 0)], give: [] },
      { payer: "you", amount: "0.00" }
    )
  ).toBe(false);
  expect(
    proposalDraftChanged(opening, { payer: "you", amount: "1" }, opening, {
      payer: "you",
      amount: "1.00",
    })
  ).toBe(false);
  for (const amount of ["0", "0.", "0.0", "0.00", ".00", "$0.00", "0,000.00"]) {
    expect(
      proposalDraftChanged(opening, NO_CASH, opening, { payer: "you", amount })
    ).toBe(false);
  }
  expect(proposalDraftChanged(opening, NO_CASH, opening, NO_CASH)).toBe(false);
  expect(
    proposalDraftChanged(EMPTY_PROPOSAL, NO_CASH, EMPTY_PROPOSAL, NO_CASH)
  ).toBe(false);
});
