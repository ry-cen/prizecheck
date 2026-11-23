import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CollectionError } from "./collection";
import {
  LOCATION_RELOAD_FAILED_MESSAGE,
  LOCATION_REVIEW_MESSAGE,
} from "./locationDestinations";
import {
  LocationWriteDialog,
  locationError,
  staleLocationCodes,
} from "./LocationWrites";
import {
  queueLocationFixtureChange,
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
async function mount(scenario: CollectionScenario = "normal", id?: string) {
  const dom = new JSDOM('<div id="root"></div>');
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.getElementById("root")!);
  const writer = collectionFixtureWriter("a", scenario);
  const reader = collectionFixtureReader("a", scenario);
  const store = collectionFixtureStore("a", scenario);
  const confirmed = vi.fn();
  const originalCreate = writer.createLocation;
  const create = vi.spyOn(writer, "createLocation");
  const render = () =>
    createElement(LocationWriteDialog, {
      action: { mode: id ? "settings" : "create", id, viewKey: "all" },
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
  return {
    root,
    reader,
    writer,
    originalCreate,
    create,
    store,
    confirmed,
    submit,
    cleanup,
  };
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
it("never submits an unchanged rename, or offers the current parent for Move", async () => {
  const f = await mount("normal", "3");
  const edit = vi.spyOn(f.writer, "editLocation");
  const click = async (name: string) =>
    act(async () => {
      [...document.querySelectorAll("button")]
        .find((b) => b.textContent === name)!
        .click();
    });
  try {
    await click("Rename");
    expect(
      document.querySelector<HTMLButtonElement>('button[type="submit"]')!
        .disabled
    ).toBe(true);
    await act(async () => f.submit());
    expect(edit).not.toHaveBeenCalled();
    expect(f.store.revision).toBe(1);
  } finally {
    await f.cleanup();
  }
  const moved = await mount("normal", "3");
  try {
    await click("Move");
    expect(document.querySelector('option[value="2"]')).toBe(null);
    expect(
      document.querySelector<HTMLButtonElement>('button[type="submit"]')!
        .disabled
    ).toBe(true);
  } finally {
    await moved.cleanup();
  }
});
it("reloads a genuinely stale destination and retries its new parentVersion with a fresh key exactly once", async () => {
  const f = await mount("location-stale", "5");
  const edit = vi.spyOn(f.writer, "editLocation");
  try {
    await act(async () => {
      [...document.querySelectorAll("button")]
        .find((b) => b.textContent === "Move")!
        .click();
    });
    await act(async () => {
      const select = document.querySelector("select")!;
      select.value = "2";
      select.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
    await act(async () => {
      f.submit();
      await vi.runAllTimersAsync();
    });
    expect(edit.mock.calls[0][0]).toMatchObject({
      version: 1,
      parentVersion: 1,
    });
    expect(f.store.locations.find((n) => n.id === "2")!.version).toBe(2);
    await act(async () => {
      [...document.querySelectorAll("button")]
        .find((b) => b.textContent === "Reload and retry")!
        .click();
      await vi.runAllTimersAsync();
    });
    expect(edit.mock.calls[1][0]).toMatchObject({
      version: 1,
      parentVersion: 2,
    });
    expect(edit.mock.calls[0][1].idempotencyKey).not.toBe(
      edit.mock.calls[1][1].idempotencyKey
    );
    expect(f.confirmed).toHaveBeenCalledTimes(1);
    expect(f.store.revision).toBe(2);
  } finally {
    await f.cleanup();
  }
});
it.each([
  [
    "INVALID_LOCATION_NAME",
    true,
    false,
    "Enter a name of 1 to 120 characters.",
  ],
  [
    "LOCATION_NAME_CONFLICT",
    false,
    true,
    "Binders already has a Location named Box.",
  ],
  [
    "LOCATION_NOT_FOUND",
    true,
    false,
    "That parent Location no longer exists. Choose another parent.",
  ],
  [
    "DECK_CANNOT_HAVE_CHILDREN",
    false,
    false,
    "A Deck cannot contain Locations.",
  ],
] as const)("maps %s per operation", (code, create, moving, message) => {
  expect(
    locationError(new CollectionError(code), "Box", create, moving, "Binders")
  ).toBe(message);
});
it("classifies all tree-change refusals for reload and retry", () => {
  for (const code of [
    "STALE_LOCATION",
    "STOCKED_LOCATION_REQUIRES_CONVERSION",
    "INVALID_LOCATION_CONVERSION",
    "LOCATION_CYCLE",
    "LOCATION_NOT_FOUND",
  ])
    expect(staleLocationCodes.has(code)).toBe(true);
});
it.each([
  [
    "stocked",
    "3",
    "5",
    { kind: "stock", id: "5" },
    "STOCKED_LOCATION_REQUIRES_CONVERSION",
  ],
  [
    "cycle",
    "5",
    "2",
    { kind: "cycle", id: "2", parentId: "5" },
    "LOCATION_CYCLE",
  ],
  [
    "missing destination",
    "5",
    "2",
    { kind: "delete", id: "2" },
    "LOCATION_NOT_FOUND",
  ],
] as const)(
  "resets a %s destination after refusal and never repeats the refused write",
  async (_reason, id, destination, change, code) => {
    const f = await mount("normal", id);
    const edit = vi.spyOn(f.writer, "editLocation");
    try {
      await act(async () => {
        [...document.querySelectorAll("button")]
          .find((b) => b.textContent === "Move")!
          .click();
      });
      await act(async () => {
        const select = document.querySelector("select")!;
        select.value = destination;
        select.dispatchEvent(new window.Event("change", { bubbles: true }));
      });
      queueLocationFixtureChange("a", change);
      await act(async () => {
        f.submit();
        await vi.runAllTimersAsync();
      });
      expect(edit).toHaveBeenCalledTimes(1);
      await expect(edit.mock.results[0].value).rejects.toMatchObject({ code });
      expect(document.querySelector("select")!.value).toBe("__choose__");
      expect(document.querySelector('[role="alert"]')!.textContent).toContain(
        "Your locations changed in another tab or window"
      );
      const retry = [...document.querySelectorAll("button")].find(
        (b) => b.textContent === "Reload and retry"
      )!;
      expect(retry.disabled).toBe(true);
      await act(async () => {
        retry.click();
        f.submit();
        await vi.runAllTimersAsync();
      });
      expect(edit).toHaveBeenCalledTimes(1);
      expect(f.confirmed).not.toHaveBeenCalled();
    } finally {
      await f.cleanup();
    }
  }
);
it("offers only the gone alert and picker when the edited Location disappears", async () => {
  const f = await mount("normal", "5");
  const edit = vi.spyOn(f.writer, "editLocation");
  try {
    await act(async () => {
      [...document.querySelectorAll("button")]
        .find((b) => b.textContent === "Move")!
        .click();
    });
    await act(async () => {
      const select = document.querySelector("select")!;
      select.value = "2";
      select.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
    queueLocationFixtureChange("a", { kind: "delete", id: "5" });
    await act(async () => {
      f.submit();
      await vi.runAllTimersAsync();
    });
    expect(edit).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="alert"]')!.textContent).toBe(
      "That Location no longer exists."
    );
    expect(document.querySelector("form")).toBe(null);
    expect(
      [...document.querySelectorAll("button")].some(
        (b) => b.textContent === "Reload and retry"
      )
    ).toBe(false);
    expect(
      [...document.querySelectorAll("button")].some(
        (b) => b.textContent === "Binders"
      )
    ).toBe(true);
  } finally {
    await f.cleanup();
  }
});
it("a create parent that gains cards offers conversion without resending the refused request", async () => {
  const f = await mount();
  const create = f.originalCreate;
  f.create.mockImplementation((input, options) =>
    create({ ...input, name: "New child" }, options)
  );
  try {
    await act(async () => {
      const select = document.querySelector("select")!;
      select.value = "5";
      select.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
    queueLocationFixtureChange("a", { kind: "stock", id: "5" });
    await act(async () => {
      f.submit();
      await vi.runAllTimersAsync();
    });
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(document.querySelector("select")!.value).toBe("5");
    const radio = document.querySelector<HTMLInputElement>(
      'input[type="radio"]'
    )!;
    expect(radio).not.toBe(null);
    await act(async () => {
      f.submit();
      await vi.runAllTimersAsync();
    });
    expect(f.create).toHaveBeenCalledTimes(1);
    await act(async () => radio.click());
    await act(async () => {
      f.submit();
      await vi.runAllTimersAsync();
    });
    expect(f.create).toHaveBeenCalledTimes(2);
    expect(f.create.mock.calls[1][0].conversion).toBe("move_holdings_to_child");
    expect(f.confirmed).toHaveBeenCalledTimes(1);
  } finally {
    await f.cleanup();
  }
});

it("never claims a refresh that did not happen, and Retry reads the tree before any command is resent", async () => {
  const f = await mount("location-stale", "5");
  const edit = vi.spyOn(f.writer, "editLocation");
  const read = vi.spyOn(f.reader, "locations");
  const alert = () => document.querySelector('[role="alert"]')!.textContent;
  const retry = () =>
    [...document.querySelectorAll("button")].find(
      (b) => b.textContent === "Reload and retry"
    )!;
  try {
    await act(async () => {
      [...document.querySelectorAll("button")]
        .find((b) => b.textContent === "Move")!
        .click();
    });
    await act(async () => {
      const select = document.querySelector("select")!;
      select.value = "2";
      select.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
    const down = read.mockRejectedValue(new Error("Network down"));
    await act(async () => {
      f.submit();
      await vi.runAllTimersAsync();
    });
    // The refusal went out once; its automatic read failed, so nothing was refreshed.
    expect(edit).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
    expect(alert()).toBe(LOCATION_RELOAD_FAILED_MESSAGE);
    expect(alert()).not.toContain("has been refreshed");
    expect(retry().disabled).toBe(false);
    // Retry, and Enter in the form, read first; a second read failure sends nothing and stays truthful.
    await act(async () => {
      retry().click();
      await vi.runAllTimersAsync();
    });
    await act(async () => {
      f.submit();
      await vi.runAllTimersAsync();
    });
    expect(edit).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(3);
    expect(alert()).toBe(LOCATION_RELOAD_FAILED_MESSAGE);
    expect(retry()).toBeDefined();
    // Once the read works, the tree is re-reviewed and only then is the command sent with a fresh key.
    down.mockRestore();
    await act(async () => {
      retry().click();
      await vi.runAllTimersAsync();
    });
    expect(edit).toHaveBeenCalledTimes(2);
    expect(edit.mock.calls[1][0]).toMatchObject({
      version: 1,
      parentVersion: 2,
    });
    expect(edit.mock.calls[0][1].idempotencyKey).not.toBe(
      edit.mock.calls[1][1].idempotencyKey
    );
    expect(f.confirmed).toHaveBeenCalledTimes(1);
  } finally {
    await f.cleanup();
  }
});
it("says the list was refreshed only when the refresh worked", async () => {
  const f = await mount("location-stale", "5");
  try {
    await act(async () => {
      [...document.querySelectorAll("button")]
        .find((b) => b.textContent === "Move")!
        .click();
    });
    await act(async () => {
      const select = document.querySelector("select")!;
      select.value = "2";
      select.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
    await act(async () => {
      f.submit();
      await vi.runAllTimersAsync();
    });
    expect(document.querySelector('[role="alert"]')!.textContent).toBe(
      LOCATION_REVIEW_MESSAGE
    );
  } finally {
    await f.cleanup();
  }
});
