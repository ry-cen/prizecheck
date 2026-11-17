// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import { TOAST_LIFETIME_MS, ToastProvider, useToast } from "../ui/Toast";
import { useUndoToast } from "./UndoToast";
import type { ToastState } from "./useInventoryActions";
let root: ReturnType<typeof createRoot>,
  element: HTMLDivElement,
  kit: ReturnType<typeof useToast>;
let state: ToastState | null, shown: boolean, busy: boolean;
const hostNotice: { current: number | null } = { current: null };
const superseded = vi.fn();
function Probe() {
  kit = useToast();
  useUndoToast({
    toast: state,
    busy,
    shown,
    hostNotice,
    onSuperseded: superseded,
    onUndo: () => {},
    onDismiss: () => {},
    onClose: () => {},
  });
  return null;
}
async function render() {
  await act(async () => root.render(h(ToastProvider, null, h(Probe))));
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  element = document.createElement("div");
  document.body.append(element);
  root = createRoot(element);
  state = { id: 1, message: "Restored offer", entry: null, unavailable: false };
  shown = true;
  busy = false;
  hostNotice.current = null;
  superseded.mockClear();
});
afterEach(async () => {
  await act(async () => root.unmount());
  element.remove();
  vi.unstubAllGlobals();
});
test("records host id and keeps it across update", async () => {
  await render();
  expect(hostNotice.current).toBe(kit.getVersion());
  const id = hostNotice.current;
  busy = true;
  await render();
  expect(hostNotice.current).toBe(id);
});
test("clears host id when hidden or unmounted and records re-show", async () => {
  await render();
  shown = false;
  await render();
  expect(hostNotice.current).toBeNull();
  shown = true;
  await render();
  expect(hostNotice.current).toBe(kit.getVersion());
  await act(async () => root.unmount());
  expect(hostNotice.current).toBeNull();
  root = createRoot(element);
});
test("rejects a delayed state after another owner shows and never retries it", async () => {
  state = null;
  await render();
  const since = kit.getVersion();
  await act(async () => {
    kit.show({ message: "Sign-out failed" });
    state = {
      id: 1,
      since,
      message: "Restored offer",
      entry: null,
      unavailable: false,
    };
    root.render(h(ToastProvider, null, h(Probe)));
  });
  expect(element.textContent).toContain("Sign-out failed");
  expect(element.textContent).not.toContain("Restored offer");
  expect(superseded).toHaveBeenCalledExactlyOnceWith(1);
  busy = true;
  await render();
  expect(element.textContent).toContain("Sign-out failed");
  expect(superseded).toHaveBeenCalledTimes(1);
});
test.each([false, true])(
  "draws delayed state when quiet or latest show is own: %s",
  async (own) => {
    state = null;
    await render();
    const since = kit.getVersion();
    if (own)
      await act(async () => {
        hostNotice.current = kit.show({ message: "Kept" });
      });
    state = {
      id: 1,
      since,
      message: "Restored offer",
      entry: null,
      unavailable: false,
    };
    await render();
    expect(element.textContent).toContain("Restored offer");
    expect(superseded).not.toHaveBeenCalled();
  }
);
test("re-show on return is never checked", async () => {
  state = { ...state!, since: 0 };
  await render();
  await act(async () => {
    kit.show({ message: "Other" });
  });
  shown = false;
  await render();
  shown = true;
  await render();
  expect(element.textContent).toContain("Restored offer");
  expect(superseded).not.toHaveBeenCalled();
});

test("a confirmation with no Undo leaves after its time and Collection forgets it, so it is not drawn again; a sticky failure stays", async () => {
  vi.useFakeTimers();
  try {
    await render();
    expect(element.textContent).toContain("Restored offer");
    await act(async () => vi.advanceTimersByTime(TOAST_LIFETIME_MS));
    expect(element.textContent).not.toContain("Restored offer");
    expect(superseded).toHaveBeenCalledExactlyOnceWith(1);
    state = {
      id: 2,
      message: "Undo unavailable. Refresh before continuing.",
      entry: null,
      unavailable: true,
      sticky: true,
    };
    await render();
    await act(async () => vi.advanceTimersByTime(TOAST_LIFETIME_MS * 3));
    expect(element.textContent).toContain("Refresh before continuing.");
    expect(superseded).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

test("a Collection toast waiting on its Undo lookup outlasts the lifetime, then keeps Undo or starts its own 5 s", async () => {
  vi.useFakeTimers();
  try {
    state = {
      id: 1,
      message: "Moved 2 copies.",
      entry: null,
      unavailable: false,
      sticky: true,
    };
    await render();
    await act(async () => vi.advanceTimersByTime(TOAST_LIFETIME_MS * 3));
    expect(element.textContent).toContain("Moved 2 copies.");
    expect(superseded).not.toHaveBeenCalled();
    // The lookup answers with an Undo record: the toast gains its action and stays.
    state = {
      ...state,
      entry: {
        id: "moved",
        action: "move",
        source_id: "a",
        destination_id: "b",
        source_count: 1,
        expires_at: "later",
      },
      sticky: false,
    };
    await render();
    expect(element.textContent).toContain("Undo");
    await act(async () => vi.advanceTimersByTime(TOAST_LIFETIME_MS * 3));
    expect(element.textContent).toContain("Moved 2 copies.");
    // ...or with none: the 5 s starts from the answer.
    state = {
      id: 2,
      message: "Moved 1 copy.",
      entry: null,
      unavailable: false,
      sticky: true,
    };
    await render();
    await act(async () => vi.advanceTimersByTime(TOAST_LIFETIME_MS * 3));
    state = { ...state, sticky: false };
    await render();
    await act(async () => vi.advanceTimersByTime(TOAST_LIFETIME_MS - 1));
    expect(element.textContent).toContain("Moved 1 copy.");
    await act(async () => vi.advanceTimersByTime(1));
    expect(element.textContent).not.toContain("Moved 1 copy.");
    expect(superseded).toHaveBeenCalledExactlyOnceWith(2);
  } finally {
    vi.useRealTimers();
  }
});
