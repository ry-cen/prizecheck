// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { changeDeckList } from "../decks_generated";
import type {
  WantList,
  WantListLine,
  WantListSection,
} from "../want_list_generated";
import { ToastProvider } from "../ui/Toast";
import { useWantListSwap } from "./useWantListSwap";

vi.mock("../decks_generated", async (original) => ({
  ...(await original<typeof import("../decks_generated")>()),
  changeDeckList: vi.fn(),
}));
const line: WantListLine = {
  edition_id: "A",
  name: "Iono",
  set_id: "PAL",
  set_name: "Paldea Evolved",
  collector_number: "185",
  descriptor: {},
  image_url: null,
  quantity: "1",
  held: "0",
  spare: "0",
  other_decks: "0",
  counted_from: [],
  lent: "0",
  borrowed: "0",
  owned: "0",
  need: "1",
  swap: {
    edition_id: "B",
    set_code: "PAL",
    collector_number: "254",
    descriptor: {},
    count: "1",
    listed: "0",
  },
};
const section: WantListSection = {
  deck_id: "deck",
  name: "Deck",
  deck_list_revision: 1,
  to_get: "1",
  lines: [line],
};
const initial: WantList = {
  deck_id: "deck",
  want_list_counting: "all_at_once",
  settings_revision: 1,
  owner_revision: 1,
  deck_lists_digest: "1",
  decks: [],
  sections: [section],
  combined: [],
  to_get: "1",
};
const refreshed: WantList = {
  ...initial,
  deck_lists_digest: "2",
  sections: [],
  to_get: "0",
};
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const reload = vi.fn();
function Harness({
  list,
  failed = false,
}: {
  list: WantList;
  failed?: boolean;
}) {
  const swap = useWantListSwap({ list, failed, reload, notify: vi.fn() });
  return h(
    "button",
    { onClick: () => swap.swap(section, line), disabled: swap.busy },
    "Swap"
  );
}
async function render(list = initial, failed = false) {
  await act(async () =>
    root.render(h(ToastProvider, null, h(Harness, { list, failed })))
  );
}
async function click(text: string) {
  const button = [...host.querySelectorAll("button")].find(
    (b) => b.textContent === text
  )!;
  expect(button).toBeDefined();
  await act(async () => button.click());
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(changeDeckList).mockReset();
  reload.mockReset();
  vi.mocked(changeDeckList).mockResolvedValue({
    deck_list: { revision: 2 },
  } as Awaited<ReturnType<typeof changeDeckList>>);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("control: Undo after the refresh sends the inverse at the Swap revision", async () => {
  await render();
  await click("Swap");
  await render(refreshed);
  await click("Undo");
  expect(changeDeckList).toHaveBeenCalledTimes(2);
  expect(vi.mocked(changeDeckList).mock.calls[1][1]).toMatchObject({
    revision: 2,
    changes: [
      { edition_id: "A", quantity: "1" },
      { edition_id: "B", quantity: "0" },
    ],
  });
});
it.each([false, true])(
  "honours Undo before the refresh completes (failed read: %s)",
  async (failed) => {
    await render();
    await click("Swap");
    await click("Undo");
    // A second press must not enqueue a second inverse.
    await click("Undo");
    expect(changeDeckList).toHaveBeenCalledTimes(1);
    await render(failed ? initial : refreshed, failed);
    expect(changeDeckList).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain("Undone:");
  }
);
it("leaving the page discards a waiting Undo", async () => {
  await render();
  await click("Swap");
  await click("Undo");
  await act(async () => root.render(h(ToastProvider, null)));
  await render(refreshed);
  expect(changeDeckList).toHaveBeenCalledTimes(1);
});
