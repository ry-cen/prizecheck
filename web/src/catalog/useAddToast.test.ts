// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { undoDismissals } from "../inventoryUndoNotice";
import { applyUndo, dismissUndo, listUndo } from "../inventoryUndo";
import { ToastProvider, useToast } from "../ui/Toast";
import { useAddToast, type AddedCards, type InlineUndo } from "./useAddToast";

vi.mock("../inventoryUndo", () => ({
  applyUndo: vi.fn(),
  listUndo: vi.fn(),
  dismissUndo: vi.fn(),
}));
const added: AddedCards = {
  locationId: "box",
  path: "Box",
  items: [],
  copies: 2,
  ownerRevision: 1,
  undoId: "add",
  from: "popup",
};
const removed = {
  copy_count: "2",
  source_count: 0,
  owner_revision: 2,
  edition_count: 1,
  already_at_destination_count: "0",
};
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
let notify: ReturnType<typeof useAddToast>;
let kit: ReturnType<typeof useToast>;
const onUndone = vi.fn();
beforeEach(async () => {
  vi.clearAllMocks();
  undoDismissals.reset();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(listUndo).mockResolvedValue([{ id: "add" }] as Awaited<
    ReturnType<typeof listUndo>
  >);
  vi.mocked(applyUndo).mockResolvedValue(removed);
  vi.mocked(dismissUndo).mockResolvedValue(undefined);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  function Probe() {
    kit = useToast();
    notify = useAddToast({ shown: true, onUndone });
    return null;
  }
  await act(async () => root.render(h(ToastProvider, null, h(Probe))));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function offer() {
  let undo: InlineUndo | null = null;
  await act(async () => {
    undo = await notify(added);
  });
  return undo!;
}
test("inline Undo retries a failed request with the same idempotency key", async () => {
  const undo = await offer();
  vi.mocked(applyUndo).mockRejectedValueOnce(new TypeError("lost response"));
  let failure!: Awaited<ReturnType<InlineUndo>>;
  await act(async () => {
    failure = await undo();
  });
  expect(failure.next).toBeTypeOf("function");
  expect(failure.undone).toBe(false);
  let success!: Awaited<ReturnType<InlineUndo>>;
  await act(async () => {
    success = await failure.next!();
  });
  expect(success.message).toBe("Undo removed 2 cards from Box.");
  expect(success.undone).toBe(true);
  expect(success.ownerRevision).toBe(2);
  expect(success.next).toBeNull();
  expect(vi.mocked(applyUndo).mock.calls[0]).toEqual(
    vi.mocked(applyUndo).mock.calls[1]
  );
  expect(onUndone).toHaveBeenCalledTimes(1);
});
test("a replaced toast no longer offers inline Undo", async () => {
  const undo = await offer();
  await act(async () => {
    kit.show({ message: "Draft recovered" });
  });
  expect(undo.isAvailable?.()).toBe(false);
  await act(async () => {
    expect((await undo()).next).toBeNull();
  });
  expect(applyUndo).not.toHaveBeenCalled();
  expect(host.textContent).toContain("Draft recovered");
});
test("an Undo that ran still returns its outcome when another toast replaces it", async () => {
  const undo = await offer();
  let finish!: (value: typeof removed) => void;
  vi.mocked(applyUndo).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    })
  );
  let pending!: ReturnType<InlineUndo>;
  await act(async () => {
    pending = undo();
  });
  await act(async () => {
    kit.show({ message: "Draft recovered" });
  });
  let outcome!: Awaited<ReturnType<InlineUndo>>;
  await act(async () => {
    finish(removed);
    outcome = await pending;
  });
  expect(outcome.message).toBe("Undo removed 2 cards from Box.");
  expect(outcome.undone).toBe(true);
  expect(outcome.next).toBeNull();
  expect(host.textContent).toContain("Draft recovered");
  expect(onUndone).toHaveBeenCalledTimes(1);
});
test("inline Undo awaits the toast Undo already in flight without sending another request", async () => {
  const undo = await offer();
  let finish!: (value: typeof removed) => void;
  vi.mocked(applyUndo).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    })
  );
  await act(async () => {
    host.querySelector<HTMLButtonElement>("button")!.click();
  });
  let pending!: ReturnType<InlineUndo>;
  await act(async () => {
    pending = undo();
  });
  let outcome!: Awaited<ReturnType<InlineUndo>>;
  await act(async () => {
    finish(removed);
    outcome = await pending;
  });
  expect(applyUndo).toHaveBeenCalledTimes(1);
  expect(outcome.message).toBe("Undo removed 2 cards from Box.");
  expect(outcome.undone).toBe(true);
  expect(outcome.next).toBeNull();
});

test.each(["bar", "popup"] as const)(
  "Dismiss persistently deletes an Add from %s",
  async (from) => {
    await act(async () => {
      await notify({ ...added, from });
    });
    await act(async () => {
      host
        .querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]')!
        .click();
    });
    expect(dismissUndo).toHaveBeenCalledExactlyOnceWith(added.undoId);
  }
);

test.each(["bar", "popup"] as const)(
  "Dismiss survives a failed Undo list from %s",
  async (from) => {
    vi.mocked(listUndo).mockRejectedValueOnce(new Error("503"));
    await act(async () => {
      expect(await notify({ ...added, from })).toBeNull();
    });
    expect(host.querySelector('button:not([aria-label="Dismiss"])')).toBeNull();
    await act(async () => {
      host
        .querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]')!
        .click();
    });
    expect(dismissUndo).toHaveBeenCalledExactlyOnceWith(added.undoId);
  }
);

test.each([false, true])(
  "a delayed Dismiss error preserves a newer shell notification (already dismissed: %s)",
  async (dismissed) => {
    await offer();
    let reject!: (error: Error) => void;
    vi.mocked(dismissUndo).mockReturnValueOnce(
      new Promise((_, fail) => {
        reject = fail;
      })
    );
    await act(async () => {
      host
        .querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]')!
        .click();
    });
    await act(async () => {
      const id = kit.show({ message: "Sign-out failed" });
      if (dismissed) kit.dismiss(id);
      reject(new Error("503"));
    });
    expect(host.textContent).not.toContain("Couldn't dismiss");
    if (!dismissed) expect(host.textContent).toContain("Sign-out failed");
  }
);

test("a missing record is harmless after a failed list request", async () => {
  const { MoveError } = await import("../moves_generated");
  vi.mocked(listUndo).mockRejectedValueOnce(new Error("503"));
  vi.mocked(dismissUndo).mockRejectedValueOnce(
    new MoveError(404, "UNDO_NOT_FOUND")
  );
  await offer();
  await act(async () => {
    host
      .querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]')!
      .click();
  });
  expect(dismissUndo).toHaveBeenCalledWith(added.undoId);
  expect(host.textContent).toBe("");
});

test("a failed Dismiss retries deletion without inventing an Undo offer", async () => {
  vi.mocked(listUndo).mockRejectedValueOnce(new Error("503"));
  vi.mocked(dismissUndo).mockRejectedValueOnce(new Error("503"));
  await offer();
  await act(async () => {
    host
      .querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]')!
      .click();
  });
  expect(host.textContent).toContain("Couldn't dismiss");
  expect(host.querySelector('button:not([aria-label="Dismiss"])')).toBeNull();
  await act(async () => {
    host
      .querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]')!
      .click();
  });
  expect(dismissUndo).toHaveBeenCalledTimes(2);
});

test("an incompatible Undo keeps its persistent Dismiss", async () => {
  const { MoveError } = await import("../moves_generated");
  vi.mocked(applyUndo).mockRejectedValueOnce(
    new MoveError(409, "UNDO_INCOMPATIBLE")
  );
  const undo = await offer();
  await act(async () => {
    await undo();
  });
  await act(async () => {
    host
      .querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]')!
      .click();
  });
  expect(dismissUndo).toHaveBeenCalledWith(added.undoId);
});

test("Dismiss remains persistent while Undo is pending", async () => {
  let finish!: (result: typeof removed) => void;
  vi.mocked(applyUndo).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    })
  );
  const undo = await offer();
  let pending!: ReturnType<InlineUndo>;
  await act(async () => {
    pending = undo();
  });
  await act(async () => {
    host
      .querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]')!
      .click();
  });
  expect(dismissUndo).toHaveBeenCalledWith(added.undoId);
  await act(async () => {
    finish(removed);
    await pending;
  });
});

test("two Dismiss activations before commit send one DELETE", async () => {
  await offer();
  const button = host.querySelector<HTMLButtonElement>(
    'button[aria-label="Dismiss"]'
  )!;
  await act(async () => {
    button.click();
    button.click();
  });
  expect(dismissUndo).toHaveBeenCalledTimes(1);
});
test.each(["failed", "dismissed"])(
  "double Dismiss shares its %s outcome",
  async (outcome) => {
    let resolve!: () => void, reject!: (cause: Error) => void;
    vi.mocked(dismissUndo).mockReturnValueOnce(
      new Promise((yes, no) => {
        resolve = yes;
        reject = no;
      })
    );
    await offer();
    const button = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Dismiss"]'
    )!;
    await act(async () => {
      button.click();
      button.click();
    });
    await act(async () => {
      if (outcome === "failed") reject(new Error());
      else resolve();
    });
    expect(dismissUndo).toHaveBeenCalledTimes(1);
    if (outcome === "failed") {
      expect(host.textContent?.match(/Couldn't dismiss/g)).toHaveLength(1);
      expect(
        host.querySelectorAll('button[aria-label="Dismiss"]')
      ).toHaveLength(1);
    } else expect(host.textContent).toBe("");
  }
);
test("a Dismiss already open in another owner joins it", async () => {
  let reject!: (cause: Error) => void;
  vi.mocked(dismissUndo).mockReturnValueOnce(
    new Promise((_, no) => {
      reject = no;
    })
  );
  const pending = undoDismissals.dismiss("add");
  await offer();
  await act(async () => {
    host
      .querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]')!
      .click();
  });
  expect(dismissUndo).toHaveBeenCalledTimes(1);
  await act(async () => {
    reject(new Error());
    await pending;
  });
  expect(host.textContent).toContain("Couldn't dismiss");
});

test("a delayed Add notice leaves newer Clear recovery untouched", async () => {
  let resolve!: (entries: Awaited<ReturnType<typeof listUndo>>) => void;
  vi.mocked(listUndo).mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    })
  );
  let pending!: ReturnType<typeof notify>;
  await act(async () => {
    pending = notify(added);
  });
  await act(async () => {
    kit.show({
      message: "Queue cleared.",
      action: { label: "Undo", onAction: vi.fn() },
    });
  });
  let result: InlineUndo | null = null;
  await act(async () => {
    resolve([{ id: "add" }] as Awaited<ReturnType<typeof listUndo>>);
    result = await pending;
  });
  expect(result).toBeNull();
  expect(host.textContent).toContain("Queue cleared.");
});

test("U1 a replaced Add toast's held Undo action sends nothing", async () => {
  const shown = vi.spyOn(kit, "show");
  await offer();
  const held = [...shown.mock.calls]
    .reverse()
    .find(([input]) => input.action)?.[0].action!.onAction!;
  expect(held).toBeTypeOf("function");
  await act(async () => {
    kit.show({ message: "Other" });
  });
  await act(async () => held());
  expect(applyUndo).not.toHaveBeenCalled();
  shown.mockRestore();
});

test("Catalog inline ownership withholds only the action and releases the same notice", async () => {
  const undo = await offer();
  const version = kit.getVersion();
  let release!: () => void;
  await act(async () => {
    release = undo.claimInline!();
  });
  expect(host.querySelector('button:not([aria-label="Dismiss"])')).toBeNull();
  expect(undo.isAvailable()).toBe(true);
  expect(kit.getVersion()).toBe(version);
  await act(async () => release());
  expect(host.querySelector("button")?.textContent).toBe("Undo");
  expect(kit.getVersion()).toBe(version);
});

test.each(["replacement", "dismissal"])(
  "release after %s never resurrects a notice",
  async (kind) => {
    const undo = await offer();
    let release!: () => void;
    await act(async () => {
      release = undo.claimInline!();
    });
    await act(async () => {
      if (kind === "replacement") kit.show({ message: "Queue cleared." });
      else kit.dismiss();
    });
    const version = kit.getVersion();
    await act(async () => release());
    expect(undo.isAvailable()).toBe(false);
    expect(host.querySelector('button:not([aria-label="Dismiss"])')).toBeNull();
    expect(kit.getVersion()).toBe(version);
  }
);

test("owned retry and success never move focus, including release during outstanding Undo", async () => {
  const focusTarget = document.createElement("button");
  document.body.append(focusTarget);
  focusTarget.focus();
  const undo = await offer();
  let release!: () => void;
  await act(async () => {
    release = undo.claimInline!();
  });
  vi.mocked(applyUndo).mockRejectedValueOnce(new TypeError("lost"));
  let failure!: Awaited<ReturnType<InlineUndo>>;
  await act(async () => {
    failure = await undo();
  });
  expect(document.activeElement).toBe(focusTarget);
  await act(async () => {
    release();
    release = failure.next!.claimInline!();
  });
  expect(host.querySelector('button:not([aria-label="Dismiss"])')).toBeNull();
  let finish!: (value: typeof removed) => void;
  vi.mocked(applyUndo).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    })
  );
  let pending!: ReturnType<InlineUndo>;
  await act(async () => {
    pending = failure.next!();
  });
  await act(async () => release());
  expect(host.querySelector('button[aria-disabled="true"]')).not.toBeNull();
  await act(async () => {
    finish(removed);
    await pending;
  });
  expect(document.activeElement).toBe(focusTarget);
  expect(host.querySelector('button:not([aria-label="Dismiss"])')).toBeNull();
  expect(vi.mocked(applyUndo).mock.calls[0]).toEqual(
    vi.mocked(applyUndo).mock.calls[1]
  );
  focusTarget.remove();
});

test.each(["older-first", "newer-first"])(
  "newest add wins two outstanding Undo lookups (%s)",
  async (order) => {
    let older!: (entries: Awaited<ReturnType<typeof listUndo>>) => void;
    let newer!: (entries: Awaited<ReturnType<typeof listUndo>>) => void;
    vi.mocked(listUndo)
      .mockReturnValueOnce(
        new Promise((resolve) => {
          older = resolve;
        })
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          newer = resolve;
        })
      );
    let first!: ReturnType<typeof notify>, second!: ReturnType<typeof notify>;
    await act(async () => {
      first = notify(added);
      second = notify({ ...added, undoId: "newer", path: "New box" });
    });
    let oldOffer: InlineUndo | null = null,
      newOffer: InlineUndo | null = null;
    const finishOlder = async () => {
      await act(async () => {
        older([{ id: "add" }] as Awaited<ReturnType<typeof listUndo>>);
        oldOffer = await first;
      });
    };
    const finishNewer = async () => {
      await act(async () => {
        newer([{ id: "newer" }] as Awaited<ReturnType<typeof listUndo>>);
        newOffer = await second;
      });
    };
    if (order === "older-first") {
      await finishOlder();
      expect(oldOffer).toBeNull();
      expect(host.textContent).not.toContain("Added");
      await finishNewer();
    } else {
      await finishNewer();
      await finishOlder();
    }
    expect(oldOffer).toBeNull();
    expect(newOffer).toBeTypeOf("function");
    expect(host.textContent).toContain("New box");
    await act(async () =>
      host.querySelector<HTMLButtonElement>("button")!.click()
    );
    expect(applyUndo).toHaveBeenCalledExactlyOnceWith(
      "newer",
      expect.any(String)
    );
  }
);

test("a newer add immediately invalidates an older inline offer while its lookup waits", async () => {
  const older = await offer();
  let release!: () => void;
  await act(async () => {
    release = older.claimInline!();
  });
  let finish!: (entries: Awaited<ReturnType<typeof listUndo>>) => void;
  vi.mocked(listUndo).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    })
  );
  let pending!: ReturnType<typeof notify>;
  await act(async () => {
    pending = notify({ ...added, undoId: "newer" });
  });
  expect(older.isAvailable()).toBe(false);
  await act(async () => release());
  expect(host.querySelector("button")).toBeNull();
  await act(async () => {
    finish([{ id: "newer" }] as Awaited<ReturnType<typeof listUndo>>);
    await pending;
  });
  expect(older.isAvailable()).toBe(false);
});
