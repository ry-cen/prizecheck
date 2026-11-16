// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { DeckError, setDeckCover } from "../decks_generated";
import { useDeckCover } from "./useDeckCover";

vi.mock("../decks_generated", async (original) => ({
  ...(await original<typeof import("../decks_generated")>()),
  setDeckCover: vi.fn(),
}));

let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement;
let cover!: ReturnType<typeof useDeckCover>;
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  vi.restoreAllMocks();
});

async function mount(reread: () => Promise<unknown>) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const settle = vi.fn();
  function Harness() {
    cover = useDeckCover({
      deckId: "deck",
      coverId: null,
      beginCommand: () => settle,
      onCover: () => {},
      reread,
      onMissing: () => {},
    });
    return null;
  }
  await act(async () => root!.render(createElement(Harness)));
  return settle;
}

const CHANGED = "This Deck's cover changed somewhere else, so nothing changed.";

test("a cover conflict says the Deck is up to date once its re-read loaded the Deck", async () => {
  vi.mocked(setDeckCover).mockRejectedValueOnce(
    new DeckError(409, "COVER_CHANGED")
  );
  const reread = vi.fn().mockResolvedValue({ deck: "loaded" });
  await mount(reread);
  await act(async () => cover.toggle("energy"));
  expect(reread).toHaveBeenCalledTimes(1);
  expect(cover.messageFor("energy")).toBe(
    `${CHANGED} It's up to date now: try again.`
  );
});

for (const [name, result] of [
  ["failed", null],
  ["was dropped", null],
] as const) {
  test(`a cover conflict never says up to date when its re-read ${name}`, async () => {
    vi.mocked(setDeckCover).mockRejectedValueOnce(
      new DeckError(409, "COVER_CHANGED")
    );
    await mount(vi.fn().mockResolvedValue(result));
    await act(async () => cover.toggle("energy"));
    expect(cover.messageFor("energy")).toBe(CHANGED);
  });
}

test("a cover that left the Deck List keeps its own message whatever the re-read gave", async () => {
  vi.mocked(setDeckCover).mockRejectedValueOnce(
    new DeckError(409, "COVER_NOT_ON_DECK_LIST")
  );
  await mount(vi.fn().mockResolvedValue(null));
  await act(async () => cover.toggle("energy"));
  expect(cover.messageFor("energy")).toBe(
    "This card is no longer on the Deck List, so it can't be the cover."
  );
});
