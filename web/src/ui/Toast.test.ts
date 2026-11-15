// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { ToastProvider, useToast, useToastClearance } from "./Toast";

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
