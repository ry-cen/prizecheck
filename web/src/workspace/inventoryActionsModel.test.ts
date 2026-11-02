import { expect, test } from "vitest";
import { BorrowedMoveError } from "../collection_generated";
import { MoveError } from "../moves_generated";
import {
  borrowedUnknownFailure,
  describeBorrowedFailure,
  describeFailure,
  movePreview,
  partialMoveFailure,
  unsupportedUndoFailure,
} from "./inventoryActionsModel";
const names = { place: () => "Box", card: () => "Iono", edition: () => "Iono" };
for (const [code, text] of [
  [
    "NOT_ENOUGH_BORROWED",
    "Some borrowed copies aren't where you selected them any more. Nothing moved.",
  ],
  ["LOCATION_NOT_FOUND", "Box can no longer hold cards. Nothing moved."],
  ["OTHER", "The Move was refused. Nothing moved."],
])
  test(`borrowed refusal ${code}`, () => {
    expect(
      describeBorrowedFailure(new BorrowedMoveError(409, code), "Box").text
    ).toBe(text);
  });
test("unknown borrowed outcome keeps its selection and does not reload", () => {
  expect(borrowedUnknownFailure()).toMatchObject({
    text: "The Move may not have finished. Try again to check safely; your selection is kept.",
    reloadGallery: false,
    retrySame: true,
  });
});
test("partial owned refusal reports only borrowed copies moved", () => {
  const failure = describeFailure(
    { kind: "move", destinationId: "box" },
    new MoveError(409, "STALE_HOLDING"),
    names,
    { omitNothing: true }
  );
  const partial = partialMoveFailure(2, "Box", failure, false);
  expect(partial.text).toContain(
    "Moved 2 borrowed copies to Box; your own copies didn't move:"
  );
  expect(partial.text).not.toContain("Nothing moved.");
  expect(partial.reloadGallery).toBe(true);
});
test("unknown owned outcome after borrowed success refreshes and remains retryable", () => {
  const unknown = describeFailure(
    { kind: "move", destinationId: "box" },
    new TypeError("lost"),
    names
  );
  expect(partialMoveFailure(1, "Box", unknown, true)).toMatchObject({
    text: "Moved 1 borrowed copy to Box. Moving your own copies may not have finished. Try again to check safely.",
    retrySame: true,
    reloadGallery: true,
    reloadTree: true,
  });
  expect(unknown.text).toContain("may not have finished");
  expect(unknown.reloadGallery).toBe(false);
});
test("owned-only refusal still says nothing moved", () => {
  expect(
    describeFailure(
      { kind: "move", destinationId: "box" },
      new MoveError(409, "STALE_HOLDING"),
      names
    ).text
  ).toContain("Nothing moved.");
});
test("Move preview includes stayed borrowed copies", () => {
  expect(
    movePreview(
      [
        {
          source_id: "other",
          edition_id: "edition",
          quantity: "2",
          expected_version: 1,
        },
      ],
      "box",
      [
        {
          loan_id: "loan",
          edition_id: "edition",
          from_location_id: "box",
          quantity: "3",
        },
      ]
    )
  ).toEqual({ moving: 2, alreadyThere: 3 });
});

for (const code of ["MOVE_MANIFEST_NOT_FOUND", "REPLAY_OUTCOME_UNAVAILABLE"])
  test(`unknown ${code} never claims the owned copies did not move`, () => {
    const failure = describeFailure(
      { kind: "move", destinationId: "box" },
      new MoveError(409, code),
      names,
      { unknown: true, omitNothing: true }
    );
    expect(failure.retrySame).toBe(true);
    expect(failure.text).not.toContain("Nothing moved");
    const partial = partialMoveFailure(1, "Box", failure, true);
    expect(partial.retrySame).toBe(true);
    expect(partial.text).toContain(
      "Moving your own copies may not have finished"
    );
    expect(partial.text).not.toContain("didn't move");
    expect(partial.toastText).not.toContain("Nothing moved");
  });

test("the unavailable-outcome message cannot become a definite partial refusal", () => {
  const failure = describeFailure(
    { kind: "move", destinationId: "box" },
    new MoveError(409, "REPLAY_OUTCOME_UNAVAILABLE"),
    names
  );
  const partial = partialMoveFailure(1, "Box", failure, false);
  expect(partial.retrySame).toBe(true);
  expect(partial.text).not.toContain("didn't move");
  expect(partial.text).toContain("may not have finished");
});

test("unsupported no-Undo receipt reports moved quantities without claiming protection or definite failure", () => {
  const failure = unsupportedUndoFailure(3, "Box");
  expect(failure.text).toContain("Moved 3 copies to Box. Undo unavailable.");
  expect(failure.text).toContain("Refresh before continuing.");
  expect(failure.text).not.toContain("protection");
  expect(failure.text).not.toContain("didn't move");
  expect(failure.retrySame).toBe(true);
});

for (const status of [404, 405])
  test(`a definitive initial unknown-route ${status} reports unavailable and preserves borrowed progress`, () => {
    const failure = describeFailure(
      { kind: "move", destinationId: "dest" },
      new MoveError(status, "MOVE_REQUEST_FAILED"),
      names,
      { unsupported: true, omitNothing: true }
    );
    const partial = partialMoveFailure(1, "Box", failure, false);
    expect(partial.text).toContain("Moved 1 borrowed copy to Box");
    expect(partial.text).toContain("your own copies didn't move");
    expect(partial.text).toContain("unavailable right now");
    expect(partial.text).not.toContain("Nothing moved");
    expect(partial.retrySame).toBe(false);
  });
