import { expect, it } from "vitest";
import type { FriendCopy } from "../social_generated";
import { otherEditionText } from "./friendCards";

it.each([
  [true, "normal", "other", "MEG 012"],
  [true, "reverse", "other", "MEG 012, Reverse Holo"],
  [false, "reverse", "other", "Reverse Holo"],
  [false, "normal", "edition", null],
])(
  "describes the edition (%s, %s, %s)",
  (other_printing, finish, wanted, expected) => {
    const copy: FriendCopy = {
      collector_id: "friend",
      handle: "priya",
      display_name: "priya",
      name: "Celebi",
      spare: "1",
      in_deck: "0",
      edition_id: "edition",
      set_code: "MEG",
      collector_number: "012",
      other_printing,
      descriptor: { finish },
    };
    expect(otherEditionText(copy, wanted)).toBe(expected);
  }
);
