import { describe, expect, it } from "vitest";
import { confirmEffect } from "./confirmFlow";

describe("confirmEffect", () => {
  it("lands on the destination with the count in the toast", () => {
    expect(
      confirmEffect(
        {
          kind: "saved",
          result: {
            location_id: "loc",
            edition_count: 2,
            copy_count: "5",
            owner_revision: 1,
          },
        },
        "Binder 1"
      )
    ).toEqual({
      kind: "land",
      locationId: "loc",
      toast: "Added 5 cards to Binder 1",
    });
  });

  it("says one card in the singular", () => {
    const effect = confirmEffect(
      {
        kind: "saved",
        result: {
          location_id: "l",
          edition_count: 1,
          copy_count: "1",
          owner_revision: 1,
        },
      },
      "Unsorted"
    );
    expect(effect).toMatchObject({ toast: "Added 1 card to Unsorted" });
  });

  it("reopens the picker, marks the rows and keeps a lost response frozen", () => {
    expect(confirmEffect({ kind: "destination_changed" }, "x")).toEqual({
      kind: "reopen-picker",
    });
    expect(
      confirmEffect(
        { kind: "editions_changed", rowIds: ["a"], searchRowIds: ["b"] },
        "x"
      )
    ).toEqual({ kind: "mark-rows", searchRowIds: ["b"] });
    expect(confirmEffect({ kind: "pending", code: null }, "x")).toEqual({
      kind: "frozen",
    });
  });
});
