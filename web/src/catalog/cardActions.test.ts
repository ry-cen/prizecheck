import { expect, test, vi } from "vitest";
import { batchAddHoldings, HoldingError } from "../holdings_generated";
import { addCards, outcomeKind, type AddCommand } from "./cardActions";
vi.mock("../holdings_generated", async (orig) => ({
  ...(await orig<typeof import("../holdings_generated")>()),
  batchAddHoldings: vi.fn(),
}));
const A2 = [{ editionId: "one", quantity: 2 }];
const AB = [...A2, { editionId: "two", quantity: 1 }];
const response = {
  location_id: "box",
  edition_count: 2,
  copy_count: "3",
  owner_revision: 1,
  undo_id: "undo",
};
test.each([
  ["DUPLICATE_ADD_ITEM", 422, "refused"],
  ["INVALID_QUANTITY", 422, "refused"],
  ["LOCATION_NOT_FOUND", 404, "refused"],
  ["EDITION_UNAVAILABLE", 422, "refused"],
  ["QUANTITY_OVERFLOW", 422, "refused"],
  ["REPLAY_OUTCOME_UNAVAILABLE", 409, "lost"],
  ["IDEMPOTENCY_KEY_REUSED", 409, "unknown"],
  ["INVENTORY_TEMPORARILY_UNAVAILABLE", 503, "unknown"],
  ...[401, 403, 429, 500, 422].map(
    (status) => ["HOLDING_REQUEST_FAILED", status, "unknown"] as const
  ),
  ["", 0, "unknown"],
] as const)(
  "C1 classifies every batch-add outcome %s %i",
  async (code, status, kind) => {
    vi.mocked(batchAddHoldings).mockRejectedValueOnce(
      code ? new HoldingError(status, code, "one") : new TypeError("fetch")
    );
    const result = await addCards(
      "box",
      "Box",
      [{ editionId: "one", quantity: 1 }],
      { current: null }
    );
    expect(outcomeKind(result)).toBe(kind);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.retry).toBe(kind === "unknown");
  }
);
test("C1 classifies successful batch-add outcome", async () => {
  vi.mocked(batchAddHoldings).mockResolvedValueOnce(response);
  expect(outcomeKind(await addCards("box", "Box", AB, { current: null }))).toBe(
    "added"
  );
});
test("C2 settle-first: a refused earlier batch is followed by the new one", async () => {
  vi.mocked(batchAddHoldings)
    .mockRejectedValueOnce(new HoldingError(422, "QUANTITY_OVERFLOW", "one"))
    .mockResolvedValueOnce(response);
  const pending: { current: AddCommand | null } = {
    current: { locationId: "box", path: "Box", items: A2, key: "earlier" },
  };
  const submitting = vi.fn();
  const outcome = await addCards("box", "Box", AB, pending, submitting);
  expect(submitting.mock.calls).toEqual([[A2], [AB]]);
  expect(outcome.ok).toBe(true);
  expect(pending.current).toBe(null);
});
