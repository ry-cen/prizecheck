import { expect, test } from "vitest";
import {
  isCollectionIdle,
  returnRefreshDue,
  type CollectionActivity,
  type ReturnRead,
} from "./collectionIdle";

const quiet: CollectionActivity = {
  selectedCopies: 0,
  working: false,
  dragging: false,
  actionDialogOpen: false,
  pendingCommand: false,
  detailsOpen: false,
  overlayOpen: false,
};

test("Collection with nothing selected, running, open or pending is idle", () => {
  expect(isCollectionIdle(quiet)).toBe(true);
});

test.each<[string, Partial<CollectionActivity>]>([
  ["a selection", { selectedCopies: 1 }],
  ["a Move, Removal or Undo running", { working: true }],
  ["a tile drag", { dragging: true }],
  ["the Move or Removal dialog open", { actionDialogOpen: true }],
  ["a pending or unknown-outcome Move", { pendingCommand: true }],
  ["the details sheet open", { detailsOpen: true }],
  ["another drawer, dialog or form open", { overlayOpen: true }],
])("%s makes Collection busy", (_name, busy) => {
  expect(isCollectionIdle({ ...quiet, ...busy })).toBe(false);
});

test("every busy condition together is busy, and each alone is enough", () => {
  const all: CollectionActivity = {
    selectedCopies: 3,
    working: true,
    dragging: true,
    actionDialogOpen: true,
    pendingCommand: true,
    detailsOpen: true,
    overlayOpen: true,
  };
  expect(isCollectionIdle(all)).toBe(false);
  for (const key of Object.keys(all) as (keyof CollectionActivity)[])
    expect(isCollectionIdle({ ...all, [key]: quiet[key] })).toBe(false);
});

const moved: ReturnRead = {
  idle: true,
  settled: true,
  shownRevision: 4,
  newestRevision: 5,
};

test("an idle, settled Collection whose revision moved refreshes on return", () => {
  expect(returnRefreshDue(moved)).toBe(true);
});

test.each<[string, Partial<ReturnRead>]>([
  ["Collection is busy", { idle: false }],
  ["a read is still loading", { settled: false }],
  ["the revision has not moved", { newestRevision: 4 }],
  ["the newest revision is older than the tiles", { newestRevision: 3 }],
  [
    "the revision could not be read and none was seen",
    { newestRevision: null },
  ],
  ["the tiles or the tree have no revision yet", { shownRevision: null }],
])("no refresh when %s", (_name, change) => {
  expect(returnRefreshDue({ ...moved, ...change })).toBe(false);
});
