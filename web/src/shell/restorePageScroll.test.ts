// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  RESTORE_POLL_MS,
  RESTORE_WINDOW_MS,
  restorePageScroll,
} from "./restorePageScroll";

afterEach(() => {
  vi.useRealTimers();
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
  vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(
    800
  );
  Object.defineProperty(document.documentElement, "scrollHeight", {
    configurable: true,
    get: () => height + 800,
  });
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
    setHeight: (next: number) => {
      height = next;
    },
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

it("keeps retrying a clamped position when no resize is reported, then gives up after a bounded wait", () => {
  vi.useFakeTimers();
  const view = layout(0, 100);
  const stop = restorePageScroll(document.createElement("main"), 500);
  expect(window.scrollY).toBe(100);
  view.setHeight(900);
  vi.advanceTimersByTime(RESTORE_POLL_MS);
  expect(window.scrollY).toBe(500);
  stop();

  const late = layout(0, 100);
  const stopLate = restorePageScroll(document.createElement("main"), 500);
  vi.advanceTimersByTime(RESTORE_WINDOW_MS + RESTORE_POLL_MS * 2);
  const calls = late.scroll.mock.calls.length;
  late.setHeight(900);
  vi.advanceTimersByTime(RESTORE_POLL_MS * 5);
  expect(late.scroll).toHaveBeenCalledTimes(calls);
  expect(window.scrollY).toBe(100);
  stopLate();
});

it("stops its timer on input and on release, so no later retry moves the page", () => {
  vi.useFakeTimers();
  const view = layout(0, 100);
  restorePageScroll(document.createElement("main"), 500);
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
  const calls = view.scroll.mock.calls.length;
  view.setHeight(900);
  vi.advanceTimersByTime(RESTORE_POLL_MS * 3);
  expect(view.scroll).toHaveBeenCalledTimes(calls);

  const other = layout(0, 100);
  const stop = restorePageScroll(document.createElement("main"), 500);
  stop();
  const before = other.scroll.mock.calls.length;
  other.setHeight(900);
  vi.advanceTimersByTime(RESTORE_POLL_MS * 3);
  expect(other.scroll).toHaveBeenCalledTimes(before);
});

it("lets a scroll it did not cause (scrollbar drag, find in page) take over", () => {
  vi.useFakeTimers();
  const view = layout(0, 100);
  const stop = restorePageScroll(document.createElement("main"), 500);
  expect(window.scrollY).toBe(100);
  view.setHeight(900);
  vi.stubGlobal("scrollY", 40);
  window.dispatchEvent(new Event("scroll"));
  const calls = view.scroll.mock.calls.length;
  view.setHeight(900);
  vi.advanceTimersByTime(RESTORE_POLL_MS * 3);
  expect(view.scroll).toHaveBeenCalledTimes(calls);
  expect(window.scrollY).toBe(40);
  stop();
});

it("ignores the scroll event its own restore causes", () => {
  vi.useFakeTimers();
  const view = layout(0, 100);
  const stop = restorePageScroll(document.createElement("main"), 500);
  window.dispatchEvent(new Event("scroll"));
  view.setHeight(900);
  vi.advanceTimersByTime(RESTORE_POLL_MS);
  expect(window.scrollY).toBe(500);
  stop();
});

it("keeps restoring when scroll anchoring carries the view toward the saved position before the next retry", () => {
  vi.useFakeTimers();
  const view = layout(0, 683);
  const stop = restorePageScroll(document.createElement("main"), 721);
  expect(window.scrollY).toBe(683);
  view.setHeight(1500); // grows with no resize callback
  vi.stubGlobal("scrollY", 700); // anchoring: below the saved position, on a page that now ends at 1500
  window.dispatchEvent(new Event("scroll"));
  vi.advanceTimersByTime(RESTORE_POLL_MS);
  expect(window.scrollY).toBe(721);
  stop();
});

it("keeps restoring when the browser clamps the view to a page that shrank", () => {
  vi.useFakeTimers();
  const view = layout(0, 683);
  const stop = restorePageScroll(document.createElement("main"), 721);
  expect(window.scrollY).toBe(683);
  view.setHeight(600);
  vi.stubGlobal("scrollY", 600); // clamped to the new end
  window.dispatchEvent(new Event("scroll"));
  view.setHeight(1500);
  vi.advanceTimersByTime(RESTORE_POLL_MS);
  expect(window.scrollY).toBe(721);
  stop();
});

it("leaves a scroll past the saved position alone", () => {
  vi.useFakeTimers();
  const view = layout(0, 683);
  restorePageScroll(document.createElement("main"), 721);
  view.setHeight(1500);
  vi.stubGlobal("scrollY", 740);
  window.dispatchEvent(new Event("scroll"));
  const calls = view.scroll.mock.calls.length;
  vi.advanceTimersByTime(RESTORE_POLL_MS * 3);
  expect(view.scroll).toHaveBeenCalledTimes(calls);
  expect(window.scrollY).toBe(740);
});

it("still lets an upward scroll away from the saved position take over once the page is tall", () => {
  vi.useFakeTimers();
  const view = layout(0, 100);
  restorePageScroll(document.createElement("main"), 500);
  view.setHeight(450);
  vi.advanceTimersByTime(RESTORE_POLL_MS);
  expect(window.scrollY).toBe(450);
  vi.stubGlobal("scrollY", 200);
  window.dispatchEvent(new Event("scroll"));
  const calls = view.scroll.mock.calls.length;
  view.setHeight(900);
  vi.advanceTimersByTime(RESTORE_POLL_MS * 3);
  expect(view.scroll).toHaveBeenCalledTimes(calls);
});
