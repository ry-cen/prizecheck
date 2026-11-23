import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  collectionFixtureReader,
  collectionFixtureStore,
  collectionFixtureWriter,
  resetCollectionFixtures,
  type CollectionScenario,
} from "./local/collectionFixtures";
import { editions } from "./local/fixtures";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import {
  CollectionWriteDialog,
  useCollectionFeedback,
  writeError,
} from "./CollectionWrites";
import { ToastProvider } from "../../ui/Toast";
import { CollectionError } from "./collection";
vi.mock("../../ui/Dialog", () => ({
  Dialog: ({ children }: { children: React.ReactNode }) =>
    createElement("div", { role: "dialog" }, children),
}));
let sequence = 0;
const options = (idempotencyKey = `key-${++sequence}`) => ({
  idempotencyKey,
  signal: new AbortController().signal,
});
async function settle<T>(promise: Promise<T>): Promise<T> {
  // Attach rejection handling before advancing timers.
  const outcome = promise.then(
    (value) => ({ value }),
    (error) => ({ error })
  );
  await vi.runAllTimersAsync();
  const result = await outcome;
  if ("error" in result) throw result.error;
  return result.value;
}
const editionId = editions[0].id;
function fixture(
  scenario: CollectionScenario = "normal",
  clock?: () => number
) {
  const reader = collectionFixtureReader("a", scenario);
  const writer = collectionFixtureWriter("a", scenario, clock);
  const store = collectionFixtureStore("a", scenario);
  const item = (sourceId = "1", quantity = 1) => ({
    sourceId,
    editionId,
    quantity,
    expectedVersion: store.rows.find(
      (r) => r.edition.id === editionId && r.locationId === sourceId
    )!.version,
  });
  return { reader, writer, store, item };
}
beforeEach(() => {
  vi.useFakeTimers();
  resetCollectionFixtures();
});
afterEach(() => vi.useRealTimers());
describe("fixture Collection commands", () => {
  it("increments rather than sets, versions by revision, and single Add has no Undo", async () => {
    const { reader, writer, store } = fixture();
    const result = await settle(
      writer.add({ editionId, locationId: "1", quantity: 2 }, options())
    );
    expect(result).toEqual({
      editionId,
      locationId: "1",
      quantity: 5,
      version: 2,
      ownerRevision: 2,
    });
    expect(store.revision).toBe(2);
    expect(await settle(writer.undoList(options()))).toEqual([]);
    expect(
      (await settle(reader.holdings(editionId, options().signal)))[0].quantity
    ).toBe(5);
  });
  it("replays simultaneous identical submissions once and rejects reused keys", async () => {
    const { writer, store } = fixture();
    const input = { editionId, locationId: "1", quantity: 1 };
    const key = options();
    const both = Promise.all([writer.add(input, key), writer.add(input, key)]);
    const [one, two] = await settle(both);
    expect(one).toEqual(two);
    expect(
      store.rows.find((r) => r.locationId === "1" && r.edition.id === editionId)
        ?.quantity
    ).toBe(4);
    expect(store.revision).toBe(2);
    await expect(
      settle(writer.add({ ...input, quantity: 2 }, key))
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });
  it("moves, deletes at zero, restores with a new revision, and replays consumed Undo", async () => {
    const { writer, store, item } = fixture();
    const moved = await settle(
      writer.move({ items: [item("1", 3)], destinationId: "5" }, options())
    );
    expect(
      store.rows.some((r) => r.locationId === "1" && r.edition.id === editionId)
    ).toBe(false);
    expect(store.rows.find((r) => r.locationId === "5")?.version).toBe(2);
    const undoKey = options();
    expect(await settle(writer.undo(moved.undo.id, undoKey))).toEqual({
      ownerRevision: 3,
    });
    expect(await settle(writer.undo(moved.undo.id, undoKey))).toEqual({
      ownerRevision: 3,
    });
    expect(store.rows.find((r) => r.locationId === "1")?.quantity).toBe(3);
    expect(store.rows.some((r) => r.locationId === "5")).toBe(false);
    expect(await settle(writer.undoList(options()))).toEqual([]);
  });
  it("rejects stale, insufficient and same-Location commands without writes", async () => {
    const { writer, store, item } = fixture();
    await expect(
      settle(
        writer.remove(
          { items: [{ ...item(), expectedVersion: 99 }] },
          options()
        )
      )
    ).rejects.toMatchObject({ code: "STALE_HOLDING" });
    await expect(
      settle(writer.remove({ items: [item("1", 4)] }, options()))
    ).rejects.toMatchObject({ code: "INSUFFICIENT_QUANTITY" });
    await expect(
      settle(writer.move({ items: [item()], destinationId: "1" }, options()))
    ).rejects.toMatchObject({ code: "SAME_LOCATION" });
    expect(store.revision).toBe(1);
  });
  it("only undoes the newest record and keeps at most five", async () => {
    const { writer, item } = fixture();
    const first = await settle(writer.remove({ items: [item()] }, options()));
    const second = await settle(writer.remove({ items: [item()] }, options()));
    await expect(
      settle(writer.undo(first.undo.id, options()))
    ).rejects.toMatchObject({ code: "UNDO_NOT_NEWEST" });
    await settle(writer.dismissUndo(second.undo.id, options()));
    await settle(writer.undo(first.undo.id, options()));
    for (let n = 0; n < 6; n++) {
      await settle(
        writer.add({ editionId, locationId: "1", quantity: 1 }, options())
      );
      await settle(writer.remove({ items: [item()] }, options()));
    }
    expect(await settle(writer.undoList(options()))).toHaveLength(5);
  });
  it("checks not-found, expiry and newest in core order", async () => {
    let now = 0;
    const { writer, item } = fixture("normal", () => now);
    const old = await settle(writer.remove({ items: [item()] }, options()));
    now = 1;
    await settle(writer.remove({ items: [item()] }, options()));
    now = 600_000;
    await expect(
      settle(writer.undo(old.undo.id, options()))
    ).rejects.toMatchObject({ code: "UNDO_EXPIRED" });
    await expect(
      settle(writer.undo("missing", options()))
    ).rejects.toMatchObject({ code: "UNDO_NOT_FOUND" });
    expect(await settle(writer.undoList(options()))).toHaveLength(1);
  });
  it("does not reject Undo merely because Add changed a Holding version", async () => {
    const { writer, store, item } = fixture();
    const removal = await settle(writer.remove({ items: [item()] }, options()));
    await settle(
      writer.add({ editionId, locationId: "1", quantity: 2 }, options())
    );
    await settle(writer.undo(removal.undo.id, options()));
    expect(
      store.rows.find((r) => r.locationId === "1" && r.edition.id === editionId)
    ).toMatchObject({ quantity: 5, version: 4 });
  });
  it("rejects a missing/non-leaf source or destination and an overflowing return", async () => {
    const { writer, store, item } = fixture();
    const removed = await settle(writer.remove({ items: [item()] }, options()));
    store.locations.find((n) => n.id === "1")!.kind = "organization";
    await expect(
      settle(writer.undo(removed.undo.id, options()))
    ).rejects.toMatchObject({ code: "UNDO_INCOMPATIBLE" });
    store.locations.find((n) => n.id === "1")!.kind = "storage_leaf";
    store.rows.find(
      (r) => r.locationId === "1" && r.edition.id === editionId
    )!.quantity = Number(2n ** 63n);
    await expect(
      settle(writer.undo(removed.undo.id, options()))
    ).rejects.toMatchObject({ code: "UNDO_INCOMPATIBLE" });
    store.rows.find(
      (r) => r.locationId === "1" && r.edition.id === editionId
    )!.quantity = 2;
    await settle(writer.dismissUndo(removed.undo.id, options()));
    const move = await settle(
      writer.move({ items: [item()], destinationId: "5" }, options())
    );
    store.locations = store.locations.filter((n) => n.id !== "5");
    await expect(
      settle(writer.undo(move.undo.id, options()))
    ).rejects.toMatchObject({ code: "UNDO_INCOMPATIBLE" });
  });
  it("rejects a move Undo if its destination lost the arrivals, after dismissing newer removal", async () => {
    const { writer, item } = fixture();
    const move = await settle(
      writer.move({ items: [item()], destinationId: "5" }, options())
    );
    const removal = await settle(
      writer.remove({ items: [item("5")] }, options())
    );
    await settle(writer.dismissUndo(removal.undo.id, options()));
    await expect(
      settle(writer.undo(move.undo.id, options()))
    ).rejects.toMatchObject({ code: "UNDO_INCOMPATIBLE" });
  });
  it("isolates colliding owner ids and idempotency keys", async () => {
    const { writer, store } = fixture();
    const b = collectionFixtureWriter("b");
    const key = options();
    await settle(writer.add({ editionId, locationId: "1", quantity: 2 }, key));
    expect(collectionFixtureStore("b").rows[0].quantity).toBe(2);
    expect(collectionFixtureStore("b").revision).toBe(1);
    await settle(b.add({ editionId, locationId: "1", quantity: 1 }, key));
    expect(store.rows[0].quantity).toBe(5);
    expect(collectionFixtureStore("b").rows[0].quantity).toBe(3);
  });
  it("fails once without recording success, then retries the same key", async () => {
    const { writer, store } = fixture("write-failure");
    const key = options();
    const input = { editionId, locationId: "1", quantity: 1 };
    await expect(settle(writer.add(input, key))).rejects.toThrow("Synthetic");
    expect(store.revision).toBe(1);
    await settle(writer.add(input, key));
    expect(store.revision).toBe(2);
  });
  it("stales the first selection only and aborts slow writes without mutation", async () => {
    const { writer, store, item } = fixture("stale");
    await expect(
      settle(writer.remove({ items: [item()] }, options()))
    ).rejects.toMatchObject({ code: "STALE_HOLDING" });
    expect(store.revision).toBe(1);
    await settle(writer.remove({ items: [item()] }, options()));
    const slow = fixture("write-slow");
    const controller = new AbortController();
    const pending = slow.writer.remove(
      { items: [slow.item()] },
      { idempotencyKey: "abort", signal: controller.signal }
    );
    const rejected = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    controller.abort();
    await rejected;
    expect(slow.store.revision).toBe(1);
  });
  it("maps Undo errors to collector messages", () => {
    expect(writeError(new CollectionError("UNDO_NOT_NEWEST"))).toBe(
      "This Undo is no longer available."
    );
    expect(writeError(new CollectionError("UNDO_INCOMPATIBLE"))).toBe(
      "Cards changed since then, so this can't be undone."
    );
  });
});

describe("write dialog lifetime and duplicate submission", () => {
  async function mount(
    scenario: CollectionScenario = "normal",
    remap = false,
    noLeaves = false
  ) {
    const dom = new JSDOM('<div id="root"></div>');
    vi.stubGlobal("window", dom.window);
    vi.stubGlobal("document", dom.window.document);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const root = createRoot(document.getElementById("root")!);
    const f = fixture(scenario);
    if (remap) {
      f.store.locations.forEach((n) => {
        n.id = `leaf-${n.id}`;
        if (n.parent_id) n.parent_id = `leaf-${n.parent_id}`;
      });
      f.store.rows.forEach((r) => (r.locationId = `leaf-${r.locationId}`));
    }
    if (noLeaves) f.store.locations = [];
    const confirmed = vi.fn();
    const add = vi.spyOn(f.writer, "add");
    await act(async () =>
      root.render(
        createElement(CollectionWriteDialog, {
          mode: "add",
          writer: f.writer,
          reader: f.reader,
          edition: editions[0],
          returnFocus: { current: null },
          onClose: vi.fn(),
          onConfirmed: confirmed,
        })
      )
    );
    await act(async () => {
      await vi.runAllTimersAsync();
    });
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
    return { ...f, add, confirmed, submit, root, cleanup };
  }
  it("derives Add's default from a top-level Unsorted with non-1 ids", async () => {
    const f = await mount("normal", true);
    try {
      expect(document.querySelector("select")!.value).toBe("leaf-1");
      await act(async () => {
        f.submit();
        await vi.runAllTimersAsync();
      });
      expect(f.add.mock.calls[0][0].locationId).toBe("leaf-1");
    } finally {
      await f.cleanup();
    }
  });
  it("falls back to the first leaf and disables Add if none exists", async () => {
    const f = await mount("normal", true);
    try {
      f.store.locations.find((n) => n.id === "leaf-1")!.name = "Loose cards";
      // A fresh reader identity makes the dialog load the changed tree.
      await act(async () =>
        f.root.render(
          createElement(CollectionWriteDialog, {
            mode: "add",
            writer: f.writer,
            reader: collectionFixtureReader("a"),
            edition: editions[0],
            returnFocus: { current: null },
            onClose: vi.fn(),
            onConfirmed: f.confirmed,
          })
        )
      );
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      expect(document.querySelector("select")!.value).toBe("leaf-1");
    } finally {
      await f.cleanup();
    }
    const empty = await mount("normal", false, true);
    try {
      expect(
        document.querySelector<HTMLButtonElement>('button[type="submit"]')!
          .disabled
      ).toBe(true);
    } finally {
      await empty.cleanup();
    }
  });
  it("guards double Enter synchronously and applies only once in the fixture store", async () => {
    const f = await mount();
    try {
      await act(async () => {
        f.submit();
        f.submit();
        await vi.runAllTimersAsync();
      });
      expect(f.add).toHaveBeenCalledTimes(1);
      expect(f.confirmed).toHaveBeenCalledTimes(1);
      expect(f.store.rows[0].quantity).toBe(4);
      expect(f.store.revision).toBe(2);
    } finally {
      await f.cleanup();
    }
  });
  it("retries a failure with the same idempotency key", async () => {
    const f = await mount("write-failure");
    try {
      await act(async () => {
        f.submit();
        await vi.runAllTimersAsync();
      });
      expect(f.confirmed).not.toHaveBeenCalled();
      await act(async () => {
        f.submit();
        await vi.runAllTimersAsync();
      });
      expect(f.add.mock.calls[0][1].idempotencyKey).toBe(
        f.add.mock.calls[1][1].idempotencyKey
      );
      expect(f.confirmed).toHaveBeenCalledTimes(1);
      expect(f.store.revision).toBe(2);
    } finally {
      await f.cleanup();
    }
  });
  it.each(["unmount", "owner change"])(
    "ignores late results from a writer that ignores abort after %s",
    async (change) => {
      const f = await mount();
      let resolve!: (value: Awaited<ReturnType<typeof f.writer.add>>) => void;
      f.add.mockImplementation(
        () =>
          new Promise((yes) => {
            resolve = yes;
          })
      );
      try {
        await act(async () => f.submit());
        await act(async () => {
          if (change === "unmount") f.root.render(null);
          else
            f.root.render(
              createElement(CollectionWriteDialog, {
                mode: "add",
                writer: collectionFixtureWriter("b"),
                reader: collectionFixtureReader("b"),
                edition: editions[0],
                returnFocus: { current: null },
                onClose: vi.fn(),
                onConfirmed: f.confirmed,
              })
            );
        });
        await act(async () => {
          resolve({
            ownerRevision: 2,
            version: 2,
            quantity: 4,
            locationId: "1",
            editionId,
          });
        });
        expect(f.confirmed).not.toHaveBeenCalled();
        if (change === "unmount") expect(document.body.textContent).toBe("");
        else {
          await act(async () => {
            await vi.runAllTimersAsync();
          });
          expect(
            document.querySelector<HTMLButtonElement>('button[type="submit"]')!
              .disabled
          ).toBe(false);
          await act(async () => {
            f.submit();
            await vi.runAllTimersAsync();
          });
          expect(f.confirmed).toHaveBeenCalledTimes(1);
          expect(collectionFixtureStore("b").rows[0].quantity).toBe(3);
        }
      } finally {
        await f.cleanup();
      }
    }
  );
});

describe("Undo toast operation", () => {
  async function mountFeedback() {
    const dom = new JSDOM('<div id="root"></div>', {
      url: "http://localhost/",
    });
    for (const [name, value] of Object.entries({
      window: dom.window,
      document: dom.window.document,
      IS_REACT_ACT_ENVIRONMENT: true,
    }))
      vi.stubGlobal(name, value);
    const root = createRoot(document.getElementById("root")!);
    const f = fixture();
    const removed = await settle(
      f.writer.remove({ items: [f.item()] }, options())
    );
    const refresh = vi.fn();
    let feedback!: ReturnType<typeof useCollectionFeedback>;
    function Probe() {
      feedback = useCollectionFeedback(f.writer, refresh);
      return null;
    }
    await act(async () =>
      root.render(createElement(ToastProvider, null, createElement(Probe)))
    );
    await act(async () => feedback(removed, "Removed 1 copy", removed.undo));
    const click = async (label: string) =>
      act(async () => {
        const button = [...document.querySelectorAll("button")].find(
          (b) => b.textContent === label
        )!;
        expect(button).toBeDefined();
        button.click();
        await vi.runAllTimersAsync();
      });
    return {
      ...f,
      root,
      removed,
      feedback: (message: string) =>
        feedback({ ownerRevision: f.store.revision }, message),
      click,
      cleanup: async () => {
        await act(async () => root.unmount());
        dom.window.close();
        vi.unstubAllGlobals();
      },
    };
  }
  it.each(["transient", "lost response"])(
    "keeps same-key Undo retry after %s without applying twice",
    async (failure) => {
      const f = await mountFeedback();
      const original = f.writer.undo;
      const calls: string[] = [];
      let first = true;
      vi.spyOn(f.writer, "undo").mockImplementation(async (id, options) => {
        calls.push(options.idempotencyKey);
        if (first) {
          first = false;
          if (failure === "lost response") await original(id, options);
          throw new Error("Temporary failure");
        }
        return original(id, options);
      });
      try {
        await f.click("Undo");
        expect(document.body.textContent).toContain("couldn't be saved");
        const revisionAfterFailure = f.store.revision;
        await f.click("Undo");
        expect(document.body.textContent).toContain("Undone");
        expect(calls).toHaveLength(2);
        expect(calls[0]).toBe(calls[1]);
        expect(f.store.rows[0].quantity).toBe(3);
        expect(f.store.revision).toBe(3);
        if (failure === "lost response")
          expect(f.store.revision).toBe(revisionAfterFailure);
      } finally {
        await f.cleanup();
      }
    }
  );
  it.each(["undo", "dismiss"])(
    "preserves a newer toast after a late %s completion",
    async (operation) => {
      const f = await mountFeedback();
      let complete!: () => void;
      const done = new Promise<void>((resolve) => (complete = resolve));
      if (operation === "undo") {
        const original = f.writer.undo;
        vi.spyOn(f.writer, "undo").mockImplementation(async (id, options) => {
          await done;
          return original(id, options);
        });
      } else {
        const original = f.writer.dismissUndo;
        vi.spyOn(f.writer, "dismissUndo").mockImplementation(
          async (id, options) => {
            await done;
            return original(id, options);
          }
        );
      }
      try {
        await f.click(operation === "undo" ? "Undo" : "Dismiss Undo");
        await settle(
          f.writer.add({ editionId, locationId: "1", quantity: 1 }, options())
        );
        await act(async () => f.feedback("Added newer copies"));
        await act(async () => {
          complete();
          await vi.runAllTimersAsync();
        });
        expect(document.body.textContent).toContain("Added newer copies");
        expect(document.body.textContent).not.toContain("Undone");
      } finally {
        await f.cleanup();
      }
    }
  );
  it("treats a missing dismissal as already dismissed, without replaying DELETE", async () => {
    const f = await mountFeedback();
    try {
      await settle(
        f.writer.dismissUndo(f.removed.undo.id, { signal: options().signal })
      );
      await expect(
        settle(
          f.writer.dismissUndo(f.removed.undo.id, { signal: options().signal })
        )
      ).rejects.toMatchObject({ code: "UNDO_NOT_FOUND" });
      await f.click("Dismiss Undo");
      expect(document.body.textContent).toBe("");
    } finally {
      await f.cleanup();
    }
  });
  it("removes Undo only after a terminal refusal", async () => {
    const f = await mountFeedback();
    vi.spyOn(f.writer, "undo").mockRejectedValue(
      new CollectionError("UNDO_EXPIRED")
    );
    try {
      await f.click("Undo");
      expect(document.body.textContent).toContain("no longer available");
      expect(
        [...document.querySelectorAll("button")].some(
          (b) => b.textContent === "Undo"
        )
      ).toBe(false);
    } finally {
      await f.cleanup();
    }
  });
});
