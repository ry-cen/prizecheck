// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
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
