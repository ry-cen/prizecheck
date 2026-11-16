// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  changeDeckList,
  DeckError,
  type DeckList,
  type DeckListCommandResult,
} from "../decks_generated";
import { useDeckListEdits, type DeckListEdit } from "./useDeckListEdits";

vi.mock("../decks_generated", async (original) => ({
  ...(await original<typeof import("../decks_generated")>()),
  changeDeckList: vi.fn(),
}));
vi.mock("../ui/Toast", () => ({
  useToast: () => ({
    show: () => 1,
    update: () => {},
    dismiss: () => {},
    focus: () => false,
  }),
}));

let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement;
let edits!: ReturnType<typeof useDeckListEdits>;
beforeEach(() => {
  vi.mocked(changeDeckList).mockReset();
});
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  vi.restoreAllMocks();
});

const STALE = new DeckError(409, "STALE_DECK_LIST");
const SHORT =
  "This Deck changed somewhere else, so your last change wasn't saved.";

function list(revision: number, quantity = "1"): DeckList {
  return {
    revision,
    lines: [{ edition_id: "energy", quantity }],
  } as unknown as DeckList;
}
const add: DeckListEdit = {
  deltas: new Map([["energy", 1n]]),
  names: new Map([["energy", "Energy"]]),
  message: "Added 1 Energy.",
};

async function mount(reread: () => Promise<DeckList | null>) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const onSettled = vi.fn();
  function Harness() {
    edits = useDeckListEdits({
      deckId: "deck",
      deckList: list(1),
      onResult: () => {},
      onSettled,
      reread,
      onMissing: () => {},
    });
    return null;
  }
  await act(async () => root!.render(createElement(Harness)));
  return onSettled;
}

test("a refusal after the one rebuild says the change wasn't saved, without claiming the Deck is up to date", async () => {
  vi.mocked(changeDeckList).mockRejectedValue(STALE);
  const reread = vi.fn().mockResolvedValue(list(2));
  await mount(reread);
  await act(async () => edits.edit(add));
  expect(reread).toHaveBeenCalledTimes(1);
  expect(changeDeckList).toHaveBeenCalledTimes(2);
  expect(edits.notice?.text).toBe(SHORT);
  expect(edits.notice?.retry).toBeNull();
});

test("a refusal after a rebuild whose re-read failed says the same short text", async () => {
  vi.mocked(changeDeckList).mockRejectedValue(STALE);
  const reread = vi.fn().mockResolvedValue(null);
  await mount(reread);
  await act(async () => edits.edit(add));
  expect(reread).toHaveBeenCalledTimes(1);
  expect(edits.notice?.text).toBe(SHORT);
});

test("the first refusal rebuilds on the fresh Deck List and shows no notice", async () => {
  vi.mocked(changeDeckList)
    .mockRejectedValueOnce(STALE)
    .mockResolvedValueOnce({
      deck_list: list(3, "3"),
      target_format: "standard",
    } as unknown as DeckListCommandResult);
  const reread = vi.fn().mockResolvedValue(list(2, "2"));
  const settled = await mount(reread);
  await act(async () => edits.edit(add));
  expect(reread).toHaveBeenCalledTimes(1);
  expect(vi.mocked(changeDeckList).mock.calls[1][1]).toMatchObject({
    revision: 2,
    changes: [{ edition_id: "energy", quantity: "3" }],
  });
  expect(edits.notice).toBeNull();
  expect(settled).toHaveBeenCalledTimes(1);
});
