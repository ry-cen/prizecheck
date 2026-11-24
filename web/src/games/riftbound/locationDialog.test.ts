// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CollectionError, type LocationNode } from "./collection";
import { editions } from "./local/fixtures";
import {
  LOCATION_REFRESHING_MESSAGE,
  LOCATION_RELOAD_FAILED_MESSAGE,
  LOCATION_RETRY_RELOAD_FAILED_MESSAGE,
  LOCATION_REVIEW_MESSAGE,
  locationFacts,
  type LocationFact,
  type LocationStep,
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
async function mount(
  scenario: CollectionScenario = "normal",
  id?: string,
  prepare?: (store: ReturnType<typeof collectionFixtureStore>) => void
) {
  const dom = new JSDOM('<div id="root"></div>');
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.getElementById("root")!);
  const writer = collectionFixtureWriter("a", scenario);
  const reader = collectionFixtureReader("a", scenario);
  const store = collectionFixtureStore("a", scenario);
  prepare?.(store);
  const confirmed = vi.fn();
  const originalCreate = writer.createLocation;
  const create = vi.spyOn(writer, "createLocation");
  const render = () =>
    createElement(LocationWriteDialog, {
      action: { mode: id ? "settings" : "create", id, viewKey: "all" },
      nodes: structuredClone(store.locations),
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

type Store = ReturnType<typeof collectionFixtureStore>;
const shownChanges: [string, (store: Store, round?: number) => void, string][] =
  [
    [
      "the destination's parent is renamed",
      (store, round = 1) => {
        store.locations.find((n) => n.id === "6")!.name = `Archive ${round}`;
      },
      "Moving to: Archive 1 / Shelf (was Archive / Shelf)",
    ],
    [
      "the destination's parent is moved",
      (store) => {
        store.locations.find((n) => n.id === "6")!.parent_id = "2";
      },
      "Moving to: Binders / Archive / Shelf (was Archive / Shelf)",
    ],
    [
      "the Location itself is renamed",
      (store) => {
        store.locations.find((n) => n.id === "5")!.name = "Spare binder";
      },
      "Location: Spare binder (was Empty binder)",
    ],
    [
      "the Location's contents change",
      (store) => {
        store.rows.push({
          edition: editions[0],
          locationId: "5",
          quantity: 1,
          version: store.revision,
        });
      },
      "Copies: 1 copy (was 0 copies)",
    ],
  ];
/** An Archive folder holding an empty Shelf, so a destination has an ancestor that can change. */
const withArchive = (store: Store) => {
  const base = store.locations.find((n) => n.id === "3")!;
  store.locations.push(
    {
      ...base,
      id: "6",
      name: "Archive",
      parent_id: null,
      kind: "organization",
      depth: 1,
    },
    {
      ...base,
      id: "7",
      name: "Shelf",
      parent_id: "6",
      kind: "storage_leaf",
      depth: 2,
    }
  );
};
async function openMove(destination: string) {
  const f = await mount("location-stale", "5", withArchive);
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
  return f;
}
const retryButton = () =>
  [...document.querySelectorAll("button")].find(
    (b) => b.textContent === "Reload and retry"
  )!;
const press = (how: "retry" | "enter", f: { submit: () => void }) =>
  act(async () => {
    if (how === "retry") retryButton().click();
    else f.submit();
    await vi.runAllTimersAsync();
  });
describe.each([
  ["the first reload succeeded", false],
  ["the first reload failed", true],
] as const)("when %s", (_label, firstReadFails) => {
  it.each(
    shownChanges.flatMap(([change, apply, text]) =>
      (["retry", "enter"] as const).map(
        (how) => [change, apply, text, how] as const
      )
    )
  )(
    "sends nothing when %s until the collector confirms again (%s)",
    async (_change, apply, text, how) => {
      const f = await openMove("7");
      const edit = vi.spyOn(f.writer, "editLocation");
      const read = vi.spyOn(f.reader, "locations");
      if (firstReadFails) read.mockRejectedValueOnce(new Error("down"));
      try {
        await act(async () => {
          f.submit();
          await vi.runAllTimersAsync();
        });
        expect(edit).toHaveBeenCalledTimes(1);
        apply(f.store);
        await press(how, f);
        // The refreshed Locations are shown, and nothing was sent.
        expect(edit).toHaveBeenCalledTimes(1);
        expect(f.confirmed).not.toHaveBeenCalled();
        const alert = document.querySelector<HTMLElement>('[role="alert"]')!;
        expect(alert.textContent).toContain(LOCATION_REVIEW_MESSAGE);
        expect(alert.textContent).toContain(text);
        expect(document.activeElement).toBe(alert);
        // Confirming what is now on screen sends once, with a fresh key and the current versions.
        await press(how, f);
        expect(edit).toHaveBeenCalledTimes(2);
        expect(edit.mock.calls[0][1].idempotencyKey).not.toBe(
          edit.mock.calls[1][1].idempotencyKey
        );
        expect(f.confirmed).toHaveBeenCalledTimes(1);
      } finally {
        await f.cleanup();
      }
    }
  );
  it("catches a second change between the display and the confirmation", async () => {
    const f = await openMove("7");
    const edit = vi.spyOn(f.writer, "editLocation");
    const read = vi.spyOn(f.reader, "locations");
    if (firstReadFails) read.mockRejectedValueOnce(new Error("down"));
    try {
      await act(async () => {
        f.submit();
        await vi.runAllTimersAsync();
      });
      shownChanges[0][1](f.store, 1);
      await press("retry", f);
      shownChanges[0][1](f.store, 2);
      await press("retry", f);
      expect(edit).toHaveBeenCalledTimes(1);
      expect(f.confirmed).not.toHaveBeenCalled();
      await press("retry", f);
      expect(edit).toHaveBeenCalledTimes(2);
      expect(f.confirmed).toHaveBeenCalledTimes(1);
    } finally {
      await f.cleanup();
    }
  });
  it("still sends once with a fresh key when nothing shown changed", async () => {
    const f = await openMove("2");
    const edit = vi.spyOn(f.writer, "editLocation");
    const read = vi.spyOn(f.reader, "locations");
    if (firstReadFails) read.mockRejectedValueOnce(new Error("down"));
    try {
      await act(async () => {
        f.submit();
        await vi.runAllTimersAsync();
      });
      await press("retry", f);
      expect(edit).toHaveBeenCalledTimes(2);
      expect(edit.mock.calls[1][0]).toMatchObject({ parentVersion: 2 });
      expect(edit.mock.calls[0][1].idempotencyKey).not.toBe(
        edit.mock.calls[1][1].idempotencyKey
      );
      expect(f.confirmed).toHaveBeenCalledTimes(1);
    } finally {
      await f.cleanup();
    }
  });
});

// ---- Every fact the form states can pause a reloaded retry, and is on screen to be seen first.
const setInput = (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value"
  )!.set!;
  setter.call(input, value);
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
};
const typeInto = (label: string, value: string) =>
  act(async () => {
    const input = [...document.querySelectorAll("label")]
      .find((l) => l.textContent?.startsWith(label))!
      .querySelector("input")!;
    setInput(input, value);
  });
const choose = (value: string) =>
  act(async () => {
    const select = document.querySelector("select")!;
    select.value = value;
    select.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
const clickButton = (text: string) =>
  act(async () => {
    [...document.querySelectorAll("button")]
      .find((b) => b.textContent === text)!
      .click();
  });
const addCopy = (store: Store, locationId = "5") =>
  store.rows.push({
    edition: editions[0],
    locationId,
    quantity: 1,
    version: store.revision,
  });
const dropCopy = (store: Store, locationId = "5") => {
  const at = store.rows.findIndex((r) => r.locationId === locationId);
  store.rows.splice(at, 1);
};
const addChild = (store: Store) => {
  const base = store.locations.find((n) => n.id === "3")!;
  store.locations.push({
    ...base,
    id: "8",
    name: "Pocket",
    parent_id: "5",
    kind: "storage_leaf",
    depth: 2,
  });
};
const renameSource = (store: Store) => {
  store.locations.find((n) => n.id === "5")!.name = "Spare binder";
};
const renameArchive = (store: Store) => {
  store.locations.find((n) => n.id === "6")!.name = "Archive 1";
};
async function open(step: LocationStep) {
  if (step === "create") {
    const f = await mount("normal", undefined, withArchive);
    await choose("6");
    await typeInto("Name", "New shelf");
    return f;
  }
  const f = await mount("normal", "5", withArchive);
  await clickButton(
    step === "rename" ? "Rename" : step === "move" ? "Move" : "Delete"
  );
  if (step === "rename") await typeInto("New name", "Renamed binder");
  if (step === "move") await choose("7");
  if (step === "delete") await typeInto("Location name", "Empty binder");
  return f;
}
const methodOf = {
  create: "createLocation",
  rename: "editLocation",
  move: "editLocation",
  delete: "deleteLocation",
} as const;
const alertEl = () => document.querySelector<HTMLElement>('[role="alert"]')!;
const factsText = () => document.querySelector("dl")?.textContent ?? "";
type Cell = [
  LocationStep,
  LocationFact["key"],
  (store: Store) => void,
  string,
  boolean,
];
const cells: Cell[] = [
  [
    "rename",
    "path",
    renameSource,
    "Location: Spare binder (was Empty binder)",
    true,
  ],
  [
    "move",
    "path",
    renameSource,
    "Location: Spare binder (was Empty binder)",
    true,
  ],
  ["move", "copies", (s) => addCopy(s), "Copies: 1 copy (was 0 copies)", true],
  ["move", "inside", addChild, "Locations inside: 1 (was 0)", true],
  [
    "move",
    "parent",
    renameArchive,
    "Moving to: Archive 1 / Shelf (was Archive / Shelf)",
    true,
  ],
  [
    "delete",
    "path",
    renameSource,
    "Location: Spare binder (was Empty binder)",
    false,
  ],
  [
    "delete",
    "copies",
    (s) => addCopy(s),
    "Copies: 1 copy (was 0 copies)",
    false,
  ],
  ["delete", "inside", addChild, "Locations inside: 1 (was 0)", false],
  [
    "create",
    "parent",
    renameArchive,
    "Adding to: Archive 1 (was Archive)",
    true,
  ],
];
describe.each(cells)(
  "a changed %s fact: %s",
  (step, _key, mutate, text, sendsAfter) => {
    it.each(["retry", "enter"] as const)(
      "pauses the reloaded retry (%s) and lists the change",
      async (how) => {
        const f = await open(step);
        const send = vi.spyOn(f.writer, methodOf[step]);
        send.mockRejectedValueOnce(new CollectionError("STALE_LOCATION"));
        try {
          await act(async () => {
            f.submit();
            await vi.runAllTimersAsync();
          });
          expect(send).toHaveBeenCalledTimes(1);
          const before = factsText();
          mutate(f.store);
          await press(how, f);
          expect(send).toHaveBeenCalledTimes(1);
          expect(f.confirmed).not.toHaveBeenCalled();
          expect(factsText()).not.toBe(before);
          expect(alertEl().textContent).toContain(LOCATION_REVIEW_MESSAGE);
          expect(alertEl().textContent).toContain(text);
          expect(document.activeElement).toBe(alertEl());
          await press(how, f);
          if (sendsAfter) {
            expect(send).toHaveBeenCalledTimes(2);
            expect(f.confirmed).toHaveBeenCalledTimes(1);
          } else {
            expect(send).toHaveBeenCalledTimes(1);
            expect(retryButton().disabled).toBe(true);
          }
        } finally {
          await f.cleanup();
        }
      }
    );
  }
);
it("pauses a create whose parent gains cards to move, and a conversion must then be chosen", async () => {
  const f = await mount("normal", undefined, withArchive);
  await choose("5");
  await typeInto("Name", "New shelf");
  const create = vi.spyOn(f.writer, "createLocation");
  create.mockRejectedValueOnce(new CollectionError("STALE_LOCATION"));
  try {
    await act(async () => {
      f.submit();
      await vi.runAllTimersAsync();
    });
    addCopy(f.store);
    await press("retry", f);
    expect(create).toHaveBeenCalledTimes(1);
    expect(alertEl().textContent).toContain(
      "Copies to move: 1 copy (was none)"
    );
    expect(retryButton().disabled).toBe(true);
    expect(factsText()).toContain("Copies to move");
  } finally {
    await f.cleanup();
  }
});
it("shows every fact in the form, and the table covers every key locationFacts returns", async () => {
  const tree = (copies: number): LocationNode[] => {
    const node = (
      id: string,
      parent_id: string | null,
      kind: string,
      copyCount = 0
    ) =>
      ({
        id,
        name: `N${id}`,
        parent_id,
        kind,
        version: 1,
        depth: parent_id ? 2 : 1,
        copyCount,
      }) as LocationNode;
    return [
      node("a", null, "organization"),
      node("b", "a", "storage_leaf", copies),
      node("c", null, "storage_leaf"),
    ];
  };
  const keysOf = (step: LocationStep) =>
    new Set(
      [tree(0), tree(2)].flatMap((t) =>
        ["", "a", "b", "__choose__"].flatMap((parent) =>
          ["a", "b", "c", undefined].flatMap((id) =>
            locationFacts(step, t, id, parent).map((fact) => fact.key)
          )
        )
      )
    );
  for (const step of ["create", "rename", "move", "delete"] as const) {
    const tested = new Set(cells.filter((c) => c[0] === step).map((c) => c[1]));
    // Copies to move needs a stocked create parent; it has its own test above.
    if (step === "create") tested.add("stock");
    expect(tested).toEqual(keysOf(step));
    const f = await open(step);
    try {
      const expected = locationFacts(
        step,
        structuredClone(f.store.locations),
        step === "create" ? undefined : "5",
        step === "move" ? "7" : step === "create" ? "6" : ""
      );
      const dl = document.querySelector("dl")!;
      expect([...dl.querySelectorAll("dt")].map((t) => t.textContent)).toEqual(
        expected.map((fact) => fact.label)
      );
      expect([...dl.querySelectorAll("dd")].map((d) => d.textContent)).toEqual(
        expected.map((fact) => fact.value)
      );
    } finally {
      await f.cleanup();
    }
  }
});
describe("moving a Location", () => {
  async function moveWithRefusal(options?: { failFirstRead?: boolean }) {
    const f = await open("move");
    const send = vi.spyOn(f.writer, "editLocation");
    send.mockRejectedValueOnce(new CollectionError("STALE_LOCATION"));
    if (options?.failFirstRead)
      vi.spyOn(f.reader, "locations").mockRejectedValueOnce(new Error("down"));
    await act(async () => {
      f.submit();
      await vi.runAllTimersAsync();
    });
    return { f, send };
  }
  it("lists a change to the source and the destination together", async () => {
    const { f, send } = await moveWithRefusal();
    try {
      addCopy(f.store);
      renameArchive(f.store);
      await press("retry", f);
      expect(send).toHaveBeenCalledTimes(1);
      expect(alertEl().textContent).toContain("Copies: 1 copy (was 0 copies)");
      expect(alertEl().textContent).toContain("Moving to: Archive 1 / Shelf");
    } finally {
      await f.cleanup();
    }
  });
  it("pauses again for a second change and for a revert of a change that was shown, then sends once", async () => {
    const { f, send } = await moveWithRefusal();
    try {
      addCopy(f.store);
      await press("retry", f);
      expect(alertEl().textContent).toContain("Copies: 1 copy (was 0 copies)");
      addCopy(f.store);
      await press("retry", f);
      expect(alertEl().textContent).toContain("Copies: 2 copies (was 1 copy)");
      dropCopy(f.store);
      dropCopy(f.store);
      await press("retry", f);
      expect(send).toHaveBeenCalledTimes(1);
      expect(alertEl().textContent).toContain(
        "Copies: 0 copies (was 2 copies)"
      );
      await press("retry", f);
      expect(send).toHaveBeenCalledTimes(2);
      expect(f.confirmed).toHaveBeenCalledTimes(1);
    } finally {
      await f.cleanup();
    }
  });
  it("sends when a change was made and undone before it was ever shown", async () => {
    const { f, send } = await moveWithRefusal();
    try {
      addCopy(f.store);
      dropCopy(f.store);
      renameArchive(f.store);
      f.store.locations.find((n) => n.id === "6")!.name = "Archive";
      await press("retry", f);
      expect(send).toHaveBeenCalledTimes(2);
      expect(f.confirmed).toHaveBeenCalledTimes(1);
    } finally {
      await f.cleanup();
    }
  });
  it("diffs against the last facts shown after a failed reload", async () => {
    const { f, send } = await moveWithRefusal({ failFirstRead: true });
    try {
      expect(alertEl().textContent).toContain(LOCATION_RELOAD_FAILED_MESSAGE);
      addCopy(f.store);
      await press("retry", f);
      expect(send).toHaveBeenCalledTimes(1);
      expect(alertEl().textContent).toContain("Copies: 1 copy (was 0 copies)");
    } finally {
      await f.cleanup();
    }
  });
  it("still alerts after a failed reload when the collector edits a field and then something changes", async () => {
    const { f, send } = await moveWithRefusal({ failFirstRead: true });
    try {
      await choose("2");
      await choose("7");
      addCopy(f.store);
      await press("retry", f);
      expect(send).toHaveBeenCalledTimes(1);
      expect(alertEl().textContent).toContain("Copies: 1 copy (was 0 copies)");
      expect(document.activeElement).toBe(alertEl());
    } finally {
      await f.cleanup();
    }
  });
  it("lists a change that arrives in the refusal's own refresh", async () => {
    const f = await open("move");
    const send = vi.spyOn(f.writer, "editLocation");
    send.mockImplementationOnce(async () => {
      addCopy(f.store);
      throw new CollectionError("STALE_LOCATION");
    });
    try {
      await act(async () => {
        f.submit();
        await vi.runAllTimersAsync();
      });
      expect(alertEl().textContent).toContain("Copies: 1 copy (was 0 copies)");
      expect(document.activeElement).toBe(alertEl());
      await press("retry", f);
      expect(send).toHaveBeenCalledTimes(2);
    } finally {
      await f.cleanup();
    }
  });
  it("offers the picker and focuses the notice when the source is deleted", async () => {
    const { f, send } = await moveWithRefusal();
    try {
      f.store.locations.splice(
        f.store.locations.findIndex((n) => n.id === "5"),
        1
      );
      await press("retry", f);
      expect(send).toHaveBeenCalledTimes(1);
      expect(alertEl().textContent).toBe("That Location no longer exists.");
      expect(document.activeElement).toBe(alertEl());
      expect(document.querySelector("form")).toBe(null);
    } finally {
      await f.cleanup();
    }
  });
  it("says the destination is no longer chosen when it is deleted, and disables Retry until one is picked", async () => {
    const { f, send } = await moveWithRefusal();
    try {
      f.store.locations.splice(
        f.store.locations.findIndex((n) => n.id === "7"),
        1
      );
      await press("retry", f);
      expect(send).toHaveBeenCalledTimes(1);
      expect(alertEl().textContent).toContain(
        "Moving to: Not chosen (was Archive / Shelf)"
      );
      expect(retryButton().disabled).toBe(true);
      await choose("2");
      // The read is still owed: the button stays Reload and retry, now enabled.
      expect(retryButton().disabled).toBe(false);
      expect(
        [...document.querySelectorAll("button")].some(
          (b) => b.textContent === "Move location"
        )
      ).toBe(false);
    } finally {
      await f.cleanup();
    }
  });
  it("sends on the first Retry when only a version changed", async () => {
    const { f, send } = await moveWithRefusal();
    try {
      f.store.locations.find((n) => n.id === "7")!.version++;
      await press("retry", f);
      expect(send).toHaveBeenCalledTimes(2);
      expect(f.confirmed).toHaveBeenCalledTimes(1);
    } finally {
      await f.cleanup();
    }
  });
  it("lists a changed path when the source itself is moved elsewhere", async () => {
    const { f, send } = await moveWithRefusal();
    try {
      f.store.locations.find((n) => n.id === "5")!.parent_id = "2";
      await press("retry", f);
      expect(send).toHaveBeenCalledTimes(1);
      expect(alertEl().textContent).toContain(
        "Location: Binders / Empty binder (was Empty binder)"
      );
      await press("retry", f);
      expect(send).toHaveBeenCalledTimes(2);
    } finally {
      await f.cleanup();
    }
  });

  describe("a fresh read stays owed until the write succeeds", () => {
    const keyOf = (send: { mock: { calls: unknown[][] } }, n: number) =>
      (send.mock.calls[n][1] as { idempotencyKey: string }).idempotencyKey;
    it("reads again after another parent is chosen, so a second change to the source is seen", async () => {
      const { f, send } = await moveWithRefusal();
      const read = vi.spyOn(f.reader, "locations");
      try {
        f.store.locations.splice(
          f.store.locations.findIndex((n) => n.id === "7"),
          1
        );
        await press("enter", f);
        expect(retryButton().disabled).toBe(true);
        await choose("2");
        addCopy(f.store);
        const reads = read.mock.calls.length;
        await press("enter", f);
        expect(read.mock.calls.length).toBe(reads + 1);
        expect(send).toHaveBeenCalledTimes(1);
        expect(alertEl().textContent).toContain(
          "Copies: 1 copy (was 0 copies)"
        );
        await press("enter", f);
        expect(send).toHaveBeenCalledTimes(2);
        expect(send.mock.calls[1][0]).toMatchObject({
          parentId: "2",
          parentVersion: 1,
        });
      } finally {
        await f.cleanup();
      }
    });
    it("reads again after the name is edited, so a change to the Location is seen", async () => {
      const f = await open("rename");
      const send = vi.spyOn(f.writer, "editLocation");
      send.mockRejectedValueOnce(new CollectionError("STALE_LOCATION"));
      try {
        await act(async () => {
          f.submit();
          await vi.runAllTimersAsync();
        });
        expect(send).toHaveBeenCalledTimes(1);
        await typeInto("New name", "Another name");
        renameSource(f.store);
        await press("enter", f);
        expect(send).toHaveBeenCalledTimes(1);
        expect(alertEl().textContent).toContain(
          "Location: Spare binder (was Empty binder)"
        );
        await press("enter", f);
        expect(send).toHaveBeenCalledTimes(2);
        expect(send.mock.calls[1][0]).toMatchObject({ name: "Another name" });
      } finally {
        await f.cleanup();
      }
    });
    it("reads again after another Location is picked and a new step begun", async () => {
      const { f, send } = await moveWithRefusal();
      try {
        f.store.locations.splice(
          f.store.locations.findIndex((n) => n.id === "5"),
          1
        );
        await press("enter", f);
        expect(document.querySelector("form")).toBe(null);
        await clickButton("Binders");
        await clickButton("Rename");
        await typeInto("New name", "Folders");
        // The Location is renamed elsewhere before the collector confirms.
        f.store.locations.find((n) => n.id === "2")!.name = "Albums";
        const read = vi.spyOn(f.reader, "locations");
        await press("enter", f);
        expect(read).toHaveBeenCalledTimes(1);
        expect(send).toHaveBeenCalledTimes(1);
        expect(alertEl().textContent).toContain("Location: Albums");
        await press("enter", f);
        expect(send).toHaveBeenCalledTimes(2);
        expect(send.mock.calls[1][0]).toMatchObject({
          id: "2",
          name: "Folders",
        });
      } finally {
        await f.cleanup();
      }
    });
    it("still reads first after a later error that is not a tree change", async () => {
      const { f, send } = await moveWithRefusal();
      const read = vi.spyOn(f.reader, "locations");
      try {
        send.mockRejectedValueOnce(
          new CollectionError("LOCATION_NAME_CONFLICT")
        );
        await press("enter", f);
        expect(send).toHaveBeenCalledTimes(2);
        const reads = read.mock.calls.length;
        await press("enter", f);
        expect(read.mock.calls.length).toBe(reads + 1);
        expect(send).toHaveBeenCalledTimes(3);
        expect(keyOf(send, 2)).not.toBe(keyOf(send, 1));
      } finally {
        await f.cleanup();
      }
    });
    it("sends nothing from a refused attempt when the refresh fails, and reads before a new key", async () => {
      const { f, send } = await moveWithRefusal({ failFirstRead: true });
      const read = vi.spyOn(f.reader, "locations");
      try {
        expect(alertEl().textContent).toBe(LOCATION_RELOAD_FAILED_MESSAGE);
        const reads = read.mock.calls.length;
        await press("enter", f);
        expect(read.mock.calls.length).toBe(reads + 1);
        expect(send).toHaveBeenCalledTimes(2);
        expect(keyOf(send, 1)).not.toBe(keyOf(send, 0));
      } finally {
        await f.cleanup();
      }
    });
    it("retries a command whose answer was lost with its own key and no read in between", async () => {
      const { f, send } = await moveWithRefusal();
      const read = vi.spyOn(f.reader, "locations");
      try {
        shownChanges[0][1](f.store, 1);
        await press("enter", f);
        // A changed read is shown and nothing is sent.
        expect(send).toHaveBeenCalledTimes(1);
        send.mockRejectedValueOnce(new Error("connection lost"));
        await press("enter", f);
        expect(send).toHaveBeenCalledTimes(2);
        expect(f.confirmed).not.toHaveBeenCalled();
        const reads = read.mock.calls.length;
        // Choices cannot change what is retried.
        expect(document.querySelector("select")!.disabled).toBe(true);
        await press("enter", f);
        expect(read.mock.calls.length).toBe(reads);
        expect(send).toHaveBeenCalledTimes(3);
        expect(send.mock.calls[2][0]).toEqual(send.mock.calls[1][0]);
        expect(keyOf(send, 2)).toBe(keyOf(send, 1));
        expect(send.mock.calls[1][0]).toMatchObject({ parentVersion: 1 });
        expect(f.confirmed).toHaveBeenCalledTimes(1);
        expect(f.confirmed.mock.calls[0][1]).toBe("Moved Empty binder.");
      } finally {
        await f.cleanup();
      }
    });
    it("never replays a reused key, and the next explicit submit reads first and takes a new key", async () => {
      const f = await open("rename");
      const send = vi.spyOn(f.writer, "editLocation");
      const read = vi.spyOn(f.reader, "locations");
      send.mockRejectedValueOnce(new CollectionError("IDEMPOTENCY_KEY_REUSED"));
      try {
        await act(async () => {
          f.submit();
          await vi.runAllTimersAsync();
        });
        expect(send).toHaveBeenCalledTimes(1);
        expect(read).toHaveBeenCalledTimes(0);
        expect(alertEl().textContent).toBe(
          locationError(new CollectionError("IDEMPOTENCY_KEY_REUSED"), "")
        );
        await press("enter", f);
        expect(read).toHaveBeenCalledTimes(1);
        expect(send).toHaveBeenCalledTimes(2);
        expect(keyOf(send, 1)).not.toBe(keyOf(send, 0));
      } finally {
        await f.cleanup();
      }
    });
    it("pauses when a destination is replaced by another Location with the same displayed path", async () => {
      const { f, send } = await moveWithRefusal();
      try {
        // The Archive is replaced by another Location with the same name.
        f.store.locations.find((n) => n.id === "6")!.id = "10";
        f.store.locations.find((n) => n.id === "7")!.parent_id = "10";
        await press("enter", f);
        expect(send).toHaveBeenCalledTimes(1);
        expect(alertEl().textContent).toContain(
          "The parent Location changed. Its displayed path is still Archive / Shelf."
        );
        expect(alertEl().textContent).not.toMatch(/\b10\b/);
      } finally {
        await f.cleanup();
      }
    });
    it("says a cleared choice differs from a Location named Not chosen", async () => {
      const f = await mount("normal", "5", (store) => {
        store.locations.find((n) => n.id === "2")!.name = "Not chosen";
      });
      const send = vi.spyOn(f.writer, "editLocation");
      send.mockRejectedValueOnce(new CollectionError("STALE_LOCATION"));
      try {
        await clickButton("Move");
        await choose("2");
        await act(async () => {
          f.submit();
          await vi.runAllTimersAsync();
        });
        f.store.locations.splice(
          f.store.locations.findIndex((n) => n.id === "2"),
          1
        );
        await press("enter", f);
        expect(send).toHaveBeenCalledTimes(1);
        expect(alertEl().textContent).toContain(
          "Previously selected “Not chosen”. Choose a parent Location."
        );
      } finally {
        await f.cleanup();
      }
    });
  });
});

describe("what the alert says in each state", () => {
  it("says the list is refreshing while the read is pending, then that it was refreshed", async () => {
    const f = await mount("location-stale", "5");
    try {
      await clickButton("Move");
      await choose("2");
      let finish!: () => void;
      const real = f.reader.locations.bind(f.reader);
      vi.spyOn(f.reader, "locations").mockImplementation(
        (signal) =>
          new Promise((resolve, reject) => {
            finish = () => real(signal).then(resolve, reject);
          })
      );
      await act(async () => {
        f.submit();
        await vi.runAllTimersAsync();
      });
      expect(alertEl().textContent).toBe(LOCATION_REFRESHING_MESSAGE);
      expect(alertEl().textContent).not.toContain("has been refreshed");
      await act(async () => {
        finish();
        await vi.runAllTimersAsync();
      });
      expect(alertEl().textContent).toBe(LOCATION_REVIEW_MESSAGE);
    } finally {
      await f.cleanup();
    }
  });
  it("after a reused key, never blames another tab or says to close, even when the read fails", async () => {
    const f = await open("rename");
    const send = vi.spyOn(f.writer, "editLocation");
    send.mockRejectedValueOnce(new CollectionError("IDEMPOTENCY_KEY_REUSED"));
    try {
      await act(async () => {
        f.submit();
        await vi.runAllTimersAsync();
      });
      expect(alertEl().textContent).toContain("Reload and retry");
      expect(alertEl().textContent).not.toMatch(/close|another tab/i);
      vi.spyOn(f.reader, "locations").mockRejectedValue(new Error("down"));
      await press("retry", f);
      expect(send).toHaveBeenCalledTimes(1);
      expect(alertEl().textContent).toBe(LOCATION_RETRY_RELOAD_FAILED_MESSAGE);
      expect(alertEl().textContent).not.toMatch(/close|another tab/i);
    } finally {
      await f.cleanup();
    }
  });
});
