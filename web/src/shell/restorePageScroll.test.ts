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
