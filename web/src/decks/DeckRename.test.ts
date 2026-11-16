// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { DeckError, editDeck, type TreeNode } from "../decks_generated";
import { useDeckRename } from "./DeckRename";

vi.mock("../decks_generated", async (original) => ({
  ...(await original<typeof import("../decks_generated")>()),
  editDeck: vi.fn(),
}));

let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement;
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  vi.restoreAllMocks();
});

const deck = { id: "deck", name: "Weekend", version: 4 } as unknown as TreeNode;

async function mount(reread: () => Promise<unknown>) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const settle = vi.fn();
  function Harness() {
    const rename = useDeckRename({
      deckId: "deck",
      deck,
      beginCommand: () => settle,
      onRenamed: () => {},
      reread,
      onMissing: () => {},
    });
    return createElement(
      "div",
      null,
      rename.action,
      rename.editor,
      rename.status
    );
  }
  await act(async () => root!.render(createElement(Harness)));
}

function button(name: string) {
  const found = Array.from(host.querySelectorAll("button")).find(
    (item) => item.textContent === name
  );
  expect(found).toBeDefined();
  return found!;
}

/** Opens the editor, types a new name and saves it. */
async function save(name = "Weekend Two") {
  await act(async () => button("Rename").click());
  const input = host.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )!.set!.call(input, name);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    host
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

const CHANGED = "This Deck changed somewhere else, so it wasn't renamed.";

test("a rename conflict says the Deck is up to date once its re-read loaded the Deck", async () => {
  vi.mocked(editDeck).mockRejectedValueOnce(new DeckError(409, "STALE"));
  const reread = vi.fn().mockResolvedValue({ deck: "loaded" });
  await mount(reread);
  await save();
  expect(reread).toHaveBeenCalledTimes(1);
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(
    `${CHANGED} It's up to date now: try again.`
  );
});

test("a rename conflict never says up to date when its re-read failed or was dropped", async () => {
  vi.mocked(editDeck).mockRejectedValueOnce(new DeckError(409, "STALE"));
  const reread = vi.fn().mockResolvedValue(null);
  await mount(reread);
  await save();
  expect(reread).toHaveBeenCalledTimes(1);
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(CHANGED);
});

test("a rename that worked reads the Deck once more and announces the new name", async () => {
  vi.mocked(editDeck).mockResolvedValueOnce({
    location: { ...deck, name: "Weekend Two" },
  } as never);
  const reread = vi.fn().mockResolvedValue(null);
  await mount(reread);
  await save();
  expect(reread).toHaveBeenCalledTimes(1);
  expect(host.querySelector('[role="status"]')?.textContent).toBe(
    "Renamed the Deck to Weekend Two."
  );
});
