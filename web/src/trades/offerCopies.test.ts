import { expect, it } from "vitest";
import type { TradeCard, TradeView } from "../social_generated";
import { counterProposal } from "./proposalModel";
import { withOfferInventoryCaps } from "./offerInventory";
import { offerLibrary } from "./offerCopies";
const card = (edition_id: string, copies: string): TradeCard => ({
  edition_id,
  copies,
  name: edition_id,
  set_code: "PAL",
  set_name: "Paldea",
  collector_number: "1",
  descriptor: {},
  image_url: null,
});
it.each([
  ["proposed", "proposer", 3, 2],
  ["proposed", "recipient", 2, 3],
  ["accepted", "proposer", 3, 3],
  ["accepted", "recipient", 3, 3],
] as const)(
  "releases the reserved sides of %s %s edits",
  (state, role, own, other) => {
    const offer: Pick<TradeView, "state" | "role" | "you_give" | "you_get"> = {
      state,
      role,
      you_give: [card("Own", "1")],
      you_get: [card("Other", "1")],
    };
    const mine = offerLibrary([card("Own", "2")], offer, "give");
    const theirs = offerLibrary([card("Other", "2")], offer, "get");
    const draft = withOfferInventoryCaps(counterProposal(offer), mine, theirs);
    expect(draft.give[0].copies).toBe(String(own));
    expect(draft.get[0].copies).toBe(String(other));
  }
);
it.each(["proposer", "recipient"] as const)(
  "restores missing reserved Editions for an agreed %s edit",
  (role) => {
    const offer: Pick<TradeView, "state" | "role" | "you_give" | "you_get"> = {
      state: "accepted",
      role,
      you_give: [card("Own", "1")],
      you_get: [card("Other", "2")],
    };
    expect(offerLibrary([], offer, "give")).toEqual([card("Own", "1")]);
    expect(offerLibrary([], offer, "get")).toEqual([card("Other", "2")]);
    expect(offerLibrary([], offer, "give", "absent")).toEqual([]);
  }
);

it.each(["proposer", "recipient"] as const)(
  "restores only reserved missing Editions for a proposed %s offer",
  (role) => {
    const offer: Pick<TradeView, "state" | "role" | "you_give" | "you_get"> = {
      state: "proposed",
      role,
      you_give: [card("Own", "1")],
      you_get: [card("Other", "2")],
    };
    expect(offerLibrary([], offer, "give")).toEqual(
      role === "proposer" ? [card("Own", "1")] : []
    );
    expect(offerLibrary([], offer, "get")).toEqual(
      role === "recipient" ? [card("Other", "2")] : []
    );
  }
);
