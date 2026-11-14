import { expect, it } from "vitest";
import { askControlLabel } from "./BorrowDrafts";

it.each([
  ["normal", ""],
  ["reverse", ", Reverse Holo"],
  ["holo", ", Holo"],
])("names both controls with the %s edition", (finish, suffix) => {
  const friend = {
    collector_id: "friend",
    display_name: "priya",
    handle: null,
  };
  const card = {
    edition_id: "card",
    name: "Celebi",
    set_code: "MEG",
    collector_number: "012",
    descriptor: { finish },
    image_url: null,
  };
  for (const text of ["Ask", "Ask to borrow"] as const) {
    expect(askControlLabel(text, friend, card)).toEqual({
      button:
        text === "Ask"
          ? `Ask priya for Celebi (MEG 012${suffix})`
          : `Ask to borrow Celebi from priya (MEG 012${suffix})`,
      stepper: `Copies of Celebi to ask priya for (MEG 012${suffix})`,
    });
  }
});
