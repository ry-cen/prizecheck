import { describe, expect, it } from "vitest";
import type { TradePickPlace } from "../trades_generated";
import {
  tradeNeedsPartyLabel,
  tradePickText,
  tradeStaleText,
} from "./tradeText";

describe("Trade detail counterpart context", () => {
  it.each(["withdrawn", "declined", "countered"] as const)(
    "keeps the party label for your %s headline, even when a Display Name could occur in the status words",
    (closed_reason) => {
      expect(
        tradeNeedsPartyLabel({
          state: "closed",
          closed_reason,
          closed_by: "you",
        })
      ).toBe(true);
      expect(
        tradeNeedsPartyLabel({
          state: "closed",
          closed_reason,
          closed_by: "them",
        })
      ).toBe(false);
    }
  );
  it("keeps counterpart context for system cancellations but avoids repeating name-bearing headlines", () => {
    expect(
      tradeNeedsPartyLabel({
        state: "closed",
        closed_reason: "cancelled",
        closed_by: null,
      })
    ).toBe(true);
    expect(
      tradeNeedsPartyLabel({
        state: "closed",
        closed_reason: "swapped",
        closed_by: "you",
      })
    ).toBe(false);
    expect(
      tradeNeedsPartyLabel({
        state: "accepted",
        closed_reason: null,
        closed_by: null,
      })
    ).toBe(false);
  });
});

const place = (fields: Partial<TradePickPlace>): TradePickPlace => ({
  edition_id: "e",
  location_id: "a",
  name: "Page 1",
  path: "Shelf / Binder A / Page 1",
  copies: "1",
  short: "0",
  ...fields,
});

describe("Trade pick places", () => {
  it("names each pick by its full path, so same-named Locations differ", () => {
    const picks = [
      place({ copies: "2" }),
      place({ location_id: "b", path: "Shelf / Binder B / Page 1" }),
    ];
    expect(tradePickText(picks, "e")).toBe(
      "From Shelf / Binder A / Page 1 (2) · Shelf / Binder B / Page 1 (1)"
    );
    expect(tradePickText(picks.slice(1), "e", true)).toBe(
      "from Shelf / Binder B / Page 1"
    );
  });

  it("names an out-of-date pick and its suggested replacement by path", () => {
    const stale = [place({ short: "1" })];
    const suggested = [
      place({ location_id: "b", path: "Shelf / Binder B / Page 1" }),
    ];
    expect(tradeStaleText(stale, suggested, "e")).toEqual([
      {
        key: "a",
        text: "Shelf / Binder A / Page 1 has none now · take it from Shelf / Binder B / Page 1",
      },
    ]);
  });

  it("reads Unsorted for a pick whose Location was deleted", () => {
    expect(
      tradePickText(
        [place({ location_id: null, name: "Unsorted", path: "Unsorted" })],
        "e"
      )
    ).toBe("From Unsorted");
  });
});
