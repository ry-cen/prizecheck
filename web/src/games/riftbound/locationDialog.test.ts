import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LocationWriteDialog } from "./LocationWrites";
import {
  collectionFixtureReader,
  collectionFixtureStore,
  collectionFixtureWriter,
  resetCollectionFixtures,
  type CollectionScenario,
} from "./local/collectionFixtures";
vi.mock("../../ui/Dialog", () => ({
  Dialog: ({ children }: { children: React.ReactNode }) =>
    createElement("div", { role: "dialog" }, children),
}));
beforeEach(() => {
  vi.useFakeTimers();
  resetCollectionFixtures();
});
afterEach(() => vi.useRealTimers());
async function mount(scenario: CollectionScenario = "normal") {
  const dom = new JSDOM('<div id="root"></div>');
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.getElementById("root")!);
  const writer = collectionFixtureWriter("a", scenario);
  const reader = collectionFixtureReader("a", scenario);
  const store = collectionFixtureStore("a", scenario);
  const confirmed = vi.fn();
  const create = vi.spyOn(writer, "createLocation");
  const render = () =>
    createElement(LocationWriteDialog, {
      action: { mode: "create", viewKey: "all" },
      nodes: store.locations,
      reader,
      writer,
      returnFocus: { current: null },
      onClose: vi.fn(),
      onConfirmed: confirmed,
    });
  await act(async () => root.render(render()));
  const submit = () =>
    document
      .querySelector("form")!
      .dispatchEvent(
        new dom.window.Event("submit", { bubbles: true, cancelable: true })
      );
  const cleanup = async () => {
    await act(async () => root.unmount());
    dom.window.close();
    vi.unstubAllGlobals();
  };
  // Submit directly: lifecycle guards also apply to invalid requests.
  return { root, writer, create, store, confirmed, submit, cleanup };
}
it("guards double submit before React disables the button", async () => {
  const f = await mount();
  try {
    f.create.mockResolvedValue({
      ownerRevision: 2,
      location: {
        id: "new",
        name: "New",
        parent_id: null,
        kind: "storage_leaf",
        depth: 1,
        version: 1,
      },
    });
    await act(async () => {
      f.submit();
      f.submit();
    });
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.confirmed).toHaveBeenCalledTimes(1);
  } finally {
    await f.cleanup();
  }
});
it("retains exactly the same key and payload on a transient retry", async () => {
  const f = await mount();
  try {
    f.create
      .mockRejectedValueOnce(new Error("Transient"))
      .mockResolvedValueOnce({
        ownerRevision: 2,
        location: {
          id: "new",
          name: "New",
          parent_id: null,
          kind: "storage_leaf",
          depth: 1,
          version: 1,
        },
      });
    await act(async () => f.submit());
    await act(async () => f.submit());
    expect(f.create).toHaveBeenCalledTimes(2);
    expect(f.create.mock.calls[0][0]).toEqual(f.create.mock.calls[1][0]);
    expect(f.create.mock.calls[0][1].idempotencyKey).toBe(
      f.create.mock.calls[1][1].idempotencyKey
    );
    expect(f.confirmed).toHaveBeenCalledTimes(1);
  } finally {
    await f.cleanup();
  }
});
it("ignores a confirmed result arriving after unmount even when abort is ignored", async () => {
  const f = await mount();
  try {
    let resolve!: (
      r: Awaited<ReturnType<typeof f.writer.createLocation>>
    ) => void;
    f.create.mockImplementation(
      () =>
        new Promise((yes) => {
          resolve = yes;
        })
    );
    await act(async () => f.submit());
    await act(async () => f.root.render(null));
    await act(async () =>
      resolve({
        ownerRevision: 2,
        location: {
          id: "new",
          name: "New",
          parent_id: null,
          kind: "storage_leaf",
          depth: 1,
          version: 1,
        },
      })
    );
    expect(f.confirmed).not.toHaveBeenCalled();
    expect(f.create.mock.calls[0][1].signal.aborted).toBe(true);
  } finally {
    await f.cleanup();
  }
});
