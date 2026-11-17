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

const SAVED = {
  deck_list: list(2, "2"),
  target_format: "standard",
} as unknown as DeckListCommandResult;

test("quantityOf shows a change on its way, then the confirmed quantity while its outcome is unknown, then the saved one after Try again", async () => {
  let answer!: (reason: unknown) => void;
  vi.mocked(changeDeckList).mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        answer = reject;
      })
  );
  await mount(vi.fn());
  await act(async () => edits.edit(add));
  // On its way: the collector's tap shows at once.
  expect(edits.quantityOf("energy")).toBe(2n);
  await act(async () => answer(new TypeError("Failed to fetch")));
  // No answer: nothing is confirmed, so the count is the confirmed one, and a Try again is waiting for the change.
  expect(edits.notice?.retry).toBeTypeOf("function");
  expect(edits.quantityOf("energy")).toBe(1n);
  expect(edits.uncertainOf("energy")).toBe(1n);
  expect(edits.uncertainOf("other")).toBe(0n);
  vi.mocked(changeDeckList).mockResolvedValueOnce(SAVED);
  await act(async () => edits.notice!.retry!());
  expect(vi.mocked(changeDeckList).mock.calls[1][1]).toEqual(
    vi.mocked(changeDeckList).mock.calls[0][1]
  );
  expect(edits.notice).toBeNull();
  expect(edits.quantityOf("energy")).toBe(2n);
  expect(edits.uncertainOf("energy")).toBe(0n);
});

test("a 5xx answer is just as unconfirmed: the count stays at the confirmed quantity", async () => {
  vi.mocked(changeDeckList).mockRejectedValue(new DeckError(503, "DOWN"));
  await mount(vi.fn());
  await act(async () => edits.edit(add));
  expect(edits.quantityOf("energy")).toBe(1n);
  expect(edits.notice?.retry).toBeTypeOf("function");
});

test("a tap made while a change is unconfirmed shows at once and doesn't hide the unconfirmed change", async () => {
  vi.mocked(changeDeckList).mockRejectedValueOnce(new TypeError("offline"));
  await mount(vi.fn());
  await act(async () => edits.edit(add));
  await act(async () => edits.edit(add));
  // Confirmed 1, the unconfirmed +1 isn't counted, the new tap waits behind it and is.
  expect(edits.quantityOf("energy")).toBe(2n);
  expect(edits.uncertainOf("energy")).toBe(1n);
  expect(edits.notice?.retry).toBeTypeOf("function");
});

test("each new notice has its own id, and a notice keeps its id while it stays", async () => {
  vi.mocked(changeDeckList).mockRejectedValue(new TypeError("offline"));
  await mount(vi.fn());
  await act(async () => edits.edit(add));
  const first = edits.notice!;
  expect(first.id).toBeTypeOf("number");
  await act(async () => edits.edit(add));
  // A tap while the notice stays doesn't make it a new one.
  expect(edits.notice).toBe(first);
  expect(edits.notice!.id).toBe(first.id);
  // Try again that fails again is a new notice to announce.
  await act(async () => edits.notice!.retry!());
  expect(edits.notice).not.toBe(first);
  expect(edits.notice!.id).not.toBe(first.id);
});

test("a refusal's notice has an id too", async () => {
  vi.mocked(changeDeckList).mockRejectedValue(
    new DeckError(422, "EDITION_UNAVAILABLE")
  );
  await mount(vi.fn());
  await act(async () => edits.edit(add));
  expect(edits.notice?.id).toBeTypeOf("number");
});
