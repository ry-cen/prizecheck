// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import {
  TOAST_LIFETIME_MS,
  ToastProvider,
  useToast,
  useToastClearance,
} from "./Toast";

test("the toast version counts shows synchronously, including shows dismissed before render", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let kit!: ReturnType<typeof useToast>;
  function Probe() {
    kit = useToast();
    return null;
  }
  try {
    await act(async () => root.render(h(ToastProvider, null, h(Probe))));
    expect(kit.getVersion()).toBe(0);
    await act(async () => {
      const id = kit.show({ message: "First" });
      expect(kit.getVersion()).toBe(1);
      kit.update(id, { message: "Updated" });
      kit.dismiss(id);
      expect(kit.getVersion()).toBe(1);
      kit.show({ message: "Second" });
      kit.dismiss();
      expect(kit.getVersion()).toBe(2);
    });
    expect(host.textContent).toBe("");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

test("a caller can retain visible feedback without repeating an inline announcement", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let kit!: ReturnType<typeof useToast>;
  function Probe() {
    kit = useToast();
    return null;
  }
  try {
    await act(async () => root.render(h(ToastProvider, null, h(Probe))));
    await act(async () => {
      kit.show({ message: "Default" });
    });
    expect(host.querySelector("#app-toasts")?.getAttribute("aria-live")).toBe(
      "polite"
    );
    await act(async () => {
      const input = {
        message: "Already announced inline",
        announce: false,
        action: { label: "Undo", onAction: vi.fn() },
      };
      kit.show(input);
    });
    expect(host.textContent).toContain("Already announced inline");
    expect(host.querySelector("button")?.textContent).toBe("Undo");
    expect(host.querySelector("#app-toasts")?.getAttribute("aria-live")).toBe(
      "off"
    );
    await act(async () => {
      kit.show({ message: "Next default" });
    });
    expect(host.querySelector("#app-toasts")?.getAttribute("aria-live")).toBe(
      "polite"
    );
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

test("clearance follows measured toast height and additive lifts, then resets on dismissal", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let resize!: () => void;
  let height = 0;
  const disconnect = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect = disconnect;
    }
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () => ({ height }) as DOMRect
  );
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let kit!: ReturnType<typeof useToast>;
  let clearance = -1;
  function Probe() {
    kit = useToast();
    clearance = useToastClearance();
    return null;
  }
  try {
    await act(async () => root.render(h(ToastProvider, null, h(Probe))));
    expect(clearance).toBe(0);
    height = 60;
    await act(async () => {
      kit.show({ message: "Wrapped feedback" });
    });
    expect(clearance).toBe(60);
    await act(async () => {
      kit.setLift("selection", 44);
      kit.setLift("drafts", 52);
    });
    expect(clearance).toBe(156);
    height = 100;
    await act(async () => resize());
    expect(clearance).toBe(196);
    await act(async () => kit.dismiss());
    expect(clearance).toBe(0);
    expect(disconnect).toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

/** Mounts the provider with a probe that exposes the toast API; `render` draws it again, as Shell does on navigation. */
function mount() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const box = {} as { kit: ReturnType<typeof useToast> };
  function Probe() {
    box.kit = useToast();
    return null;
  }
  const render = () =>
    act(async () => root.render(h(ToastProvider, null, h(Probe))));
  const text = () => host.querySelector("#app-toasts")?.textContent ?? "";
  return {
    host,
    box,
    render,
    text,
    async cleanup() {
      await act(async () => root.unmount());
      host.remove();
      window.history.replaceState(null, "", "/");
      vi.useRealTimers();
      vi.unstubAllGlobals();
    },
  };
}

const tick = (ms: number) => act(async () => vi.advanceTimersByTime(ms));

test("a toast with no action leaves after the lifetime; one with an action or sticky stays", async () => {
  vi.useFakeTimers();
  const page = mount();
  try {
    await page.render();
    await act(async () => {
      page.box.kit.show({ message: "Saved." });
    });
    await tick(TOAST_LIFETIME_MS - 1);
    expect(page.text()).toContain("Saved.");
    await tick(1);
    expect(page.text()).toBe("");

    for (const toast of [
      {
        message: "Undo me",
        action: { label: "Undo", onAction: vi.fn() },
      },
      {
        message: "Pick one",
        secondaryAction: { label: "Dismiss Undo", onAction: vi.fn() },
      },
      { message: "Stays", sticky: true },
    ]) {
      await act(async () => {
        page.box.kit.show(toast);
      });
      await tick(TOAST_LIFETIME_MS * 10);
      expect(page.text()).toContain(toast.message);
    }
  } finally {
    await page.cleanup();
  }
});

test("a route-scoped toast with no action also expires; with an action it does not", async () => {
  vi.useFakeTimers();
  window.history.replaceState(null, "", "/trades/1");
  const page = mount();
  try {
    await page.render();
    await act(async () => {
      page.box.kit.show({ message: "Sent.", route: "/trades/1" });
    });
    await tick(TOAST_LIFETIME_MS);
    expect(page.text()).toBe("");
    await act(async () => {
      page.box.kit.show({
        message: "Sent with Undo.",
        route: "/trades/1",
        action: { label: "Undo", onAction: vi.fn() },
      });
    });
    await tick(TOAST_LIFETIME_MS * 3);
    expect(page.text()).toContain("Sent with Undo.");
  } finally {
    await page.cleanup();
  }
});

test("replacing or updating a toast restarts its timer, and an update that adds an action stops it", async () => {
  vi.useFakeTimers();
  const page = mount();
  try {
    await page.render();
    let id = 0;
    await act(async () => {
      id = page.box.kit.show({ message: "First" });
    });
    await tick(4000);
    await act(async () => {
      page.box.kit.show({ message: "Second" });
    });
    await tick(4000);
    expect(page.text()).toContain("Second");
    await tick(1000);
    expect(page.text()).toBe("");

    await act(async () => {
      id = page.box.kit.show({ message: "Working" });
    });
    await tick(4000);
    await act(async () => {
      page.box.kit.update(id, { message: "Still working" });
    });
    await tick(4000);
    expect(page.text()).toContain("Still working");
    await tick(1000);
    expect(page.text()).toBe("");

    await act(async () => {
      id = page.box.kit.show({ message: "Plain" });
    });
    await act(async () => {
      page.box.kit.update(id, {
        message: "Now with Undo",
        action: { label: "Undo", onAction: vi.fn() },
      });
    });
    await tick(TOAST_LIFETIME_MS * 3);
    expect(page.text()).toContain("Now with Undo");
  } finally {
    await page.cleanup();
  }
});

test("unmounting the provider clears the expiry timer", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let kit!: ReturnType<typeof useToast>;
  function Probe() {
    kit = useToast();
    return null;
  }
  try {
    await act(async () => root.render(h(ToastProvider, null, h(Probe))));
    await act(async () => {
      kit.show({ message: "Saved." });
    });
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    host.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});

test("a toast with no action clears when the pathname changes, not for a query or hash change", async () => {
  vi.useFakeTimers();
  window.history.replaceState(null, "", "/decks/1");
  const page = mount();
  try {
    await page.render();
    await act(async () => {
      page.box.kit.show({ message: "Added to Trade Wants" });
    });
    window.history.pushState(null, "", "/decks/1?tab=cards#top");
    await page.render();
    expect(page.text()).toContain("Added to Trade Wants");
    window.history.pushState(null, "", "/decks/2");
    await page.render();
    expect(page.text()).toBe("");

    await act(async () => {
      page.box.kit.show({
        message: "Undo me",
        action: { label: "Undo", onAction: vi.fn() },
      });
    });
    window.history.pushState(null, "", "/collection");
    await page.render();
    expect(page.text()).toContain("Undo me");
  } finally {
    await page.cleanup();
  }
});

test("a toast shown with its own navigation survives it, then clears on the next pathname change", async () => {
  vi.useFakeTimers();
  window.history.replaceState(null, "", "/decks/1");
  const page = mount();
  try {
    await page.render();
    // Deleted, Removed, Added and the landing toast: shown, then the page moves in the same turn.
    await act(async () => {
      page.box.kit.show({ message: "Deleted Mono Red." });
      window.history.pushState(null, "", "/decks");
    });
    await page.render();
    expect(page.text()).toContain("Deleted Mono Red.");
    window.history.pushState(null, "", "/collection");
    await page.render();
    expect(page.text()).toBe("");
  } finally {
    await page.cleanup();
  }
});

test("a toast that gains no action after a pathname change starts again from the new path", async () => {
  vi.useFakeTimers();
  window.history.replaceState(null, "", "/decks/1");
  const page = mount();
  try {
    await page.render();
    let id = 0;
    await act(async () => {
      id = page.box.kit.show({
        message: "Put away",
        action: { label: "Undo", onAction: vi.fn() },
      });
    });
    window.history.pushState(null, "", "/collection");
    await page.render();
    await act(async () => {
      page.box.kit.update(id, { message: "Undo returned them" });
    });
    expect(page.text()).toContain("Undo returned them");
    await tick(TOAST_LIFETIME_MS);
    expect(page.text()).toBe("");
  } finally {
    await page.cleanup();
  }
});

test("a sticky toast stays through a pathname change", async () => {
  vi.useFakeTimers();
  window.history.replaceState(null, "", "/decks/1");
  const page = mount();
  try {
    await page.render();
    await act(async () => {
      page.box.kit.show({ message: "Couldn't sign out.", sticky: true });
    });
    window.history.pushState(null, "", "/collection");
    await page.render();
    await tick(TOAST_LIFETIME_MS * 3);
    expect(page.text()).toContain("Couldn't sign out.");
  } finally {
    await page.cleanup();
  }
});

test("expiry moves focus to the page heading only when focus was inside the toast", async () => {
  vi.useFakeTimers();
  const page = mount();
  const main = document.createElement("main");
  main.id = "main-content";
  main.innerHTML = '<h1>Decks</h1><button id="elsewhere">Elsewhere</button>';
  document.body.append(main);
  try {
    await page.render();
    await act(async () => {
      page.box.kit.show({ message: "Saved.", focus: true });
    });
    const dismiss = page.host.querySelector<HTMLButtonElement>(
      'button[aria-label="Dismiss"]'
    );
    expect(document.activeElement).toBe(dismiss);
    await tick(TOAST_LIFETIME_MS);
    expect(page.text()).toBe("");
    expect(document.activeElement).toBe(main.querySelector("h1"));

    const elsewhere = main.querySelector<HTMLButtonElement>("#elsewhere")!;
    await act(async () => {
      page.box.kit.show({ message: "Saved again." });
    });
    elsewhere.focus();
    await tick(TOAST_LIFETIME_MS);
    expect(page.text()).toBe("");
    expect(document.activeElement).toBe(elsewhere);
  } finally {
    main.remove();
    await page.cleanup();
  }
});

test("onExpire runs when a toast expires or its page changes, not when it is dismissed or replaced", async () => {
  vi.useFakeTimers();
  window.history.replaceState(null, "", "/decks/1");
  const page = mount();
  const onExpire = vi.fn();
  try {
    await page.render();
    let id = 0;
    await act(async () => {
      id = page.box.kit.show({ message: "A", onExpire });
    });
    await act(async () => page.box.kit.dismiss(id));
    await act(async () => {
      page.box.kit.show({ message: "B", onExpire });
      page.box.kit.show({ message: "C" });
    });
    await tick(TOAST_LIFETIME_MS);
    expect(onExpire).not.toHaveBeenCalled();
    await act(async () => {
      page.box.kit.show({ message: "D", onExpire });
    });
    await tick(TOAST_LIFETIME_MS);
    expect(onExpire).toHaveBeenCalledTimes(1);
    await act(async () => {
      page.box.kit.show({ message: "E", onExpire });
    });
    window.history.pushState(null, "", "/collection");
    await page.render();
    expect(onExpire).toHaveBeenCalledTimes(2);
  } finally {
    await page.cleanup();
  }
});
