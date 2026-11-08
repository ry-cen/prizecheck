// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { restorePageScroll } from "./restorePageScroll";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function layout(initial: number, available: number) {
  let y = initial;
  let height = available;
  let resize!: ResizeObserverCallback;
  const disconnect = vi.fn();
  const observe = vi.fn();
  vi.stubGlobal("scrollY", initial);
  const scroll = vi
    .spyOn(window, "scrollTo")
    .mockImplementation((_x, requested) => {
      y = Math.min(Number(requested), height);
      vi.stubGlobal("scrollY", y);
    });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        resize = callback;
      }
      observe = observe;
      disconnect = disconnect;
    }
  );
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  return {
    scroll,
    observe,
    disconnect,
    grow: (next: number) => {
      height = next;
      resize([], {} as ResizeObserver);
    },
  };
}

it("does not watch page layout for an already reached top position", () => {
  const view = layout(0, 0);
  const stop = restorePageScroll(document.createElement("main"), 0);
  expect(view.observe).not.toHaveBeenCalled();
  expect(view.scroll).not.toHaveBeenCalled();
  stop();
});

it("retries while content is too short, then releases restoration at the saved position", () => {
  const view = layout(0, 100);
  const stop = restorePageScroll(document.createElement("main"), 500);
  expect(window.scrollY).toBe(100);
  view.grow(900);
  expect(window.scrollY).toBe(500);
  expect(view.disconnect).toHaveBeenCalled();
  const calls = view.scroll.mock.calls.length;
  view.grow(1200);
  expect(view.scroll).toHaveBeenCalledTimes(calls);
  stop();
});

it("lets keyboard focus take over while content is still loading", () => {
  const view = layout(0, 100);
  const stop = restorePageScroll(document.createElement("main"), 500);
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
  const calls = view.scroll.mock.calls.length;
  view.grow(900);
  expect(view.scroll).toHaveBeenCalledTimes(calls);
  stop();
});
