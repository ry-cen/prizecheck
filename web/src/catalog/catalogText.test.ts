import { describe, expect, test } from "vitest";
import { ADD_OFFLINE, ADD_UNKNOWN, addFailed } from "./catalogText";

describe("addFailed", () => {
  test("says the device is offline only for a send that got no answer while the browser is offline", () => {
    expect(ADD_OFFLINE).toBe(
      "You're offline. Add again when you're back online."
    );
    expect(addFailed("", true, true)).toBe(ADD_OFFLINE);
  });

  test("keeps the may-have-completed wording when the browser is online", () => {
    expect(addFailed("", true)).toBe(
      "Add may have completed. Press Add again to check safely."
    );
    expect(addFailed("", true, false)).toBe(
      "Add may have completed. Press Add again to check safely."
    );
  });

  test("an answer from the server is never called offline", () => {
    expect(addFailed("HOLDING_REQUEST_FAILED", true, true)).toBe(
      "Add may have completed. Press Add again to check safely."
    );
    expect(addFailed("EDITION_UNAVAILABLE", false, true)).toBe(
      "This Edition is no longer available to add."
    );
    expect(addFailed("REPLAY_OUTCOME_UNAVAILABLE", false, true)).toBe(
      ADD_UNKNOWN
    );
  });
});
