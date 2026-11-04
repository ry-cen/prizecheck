import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { CashDraft, Proposal } from "./proposalModel";
import { ProposedOfferChanges } from "./ProposedOfferChanges";
const card = {
  edition_id: "private-edition",
  name: "Iono",
  set_code: "PAL",
  set_name: "Paldea Evolved",
  collector_number: "185",
  descriptor: { finish: "normal" },
  image_url: null,
  copies: "3",
};
const before: Proposal = { give: [], get: [{ ...card, quantity: 1 }] };
const render = (
  after: Proposal,
  cashAfter: CashDraft = { payer: "none", amount: "" }
) =>
  renderToStaticMarkup(
    h(ProposedOfferChanges, {
      before,
      after,
      cashBefore: null,
      cashAfter,
      other: "Misty",
    })
  );
it("shows quantity changes against the reviewed terms without exposing identities", () => {
  const html = render({ give: [], get: [{ ...card, quantity: 2 }] });
  expect(html).toContain("You get Iono (PAL 185): 1 → 2");
  expect(html).not.toContain("private-edition");
});
it("shows added and removed copies on their proper sides", () => {
  const html = render({ give: [{ ...card, quantity: 1 }], get: [] });
  expect(html).toContain("You give Iono (PAL 185): 0 → 1");
  expect(html).toContain("You get Iono (PAL 185): 1 → 0");
});
it("compares cash direction and whole cents, not unparsed input", () => {
  expect(render(before, { payer: "them", amount: "5" })).toContain(
    "Cash: No cash → Misty pays $5.00"
  );
  expect(render(before, { payer: "you", amount: "5.001" })).toContain(
    "Complete the cash amount before sending."
  );
});
it("does not invent changes for an unchanged draft", () => {
  expect(render(before)).toContain("No changes yet.");
});
