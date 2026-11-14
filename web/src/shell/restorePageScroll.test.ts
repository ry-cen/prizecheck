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

it("retries while content is too short and guards the saved position until release", () => {
  const view = layout(0, 100);
  const stop = restorePageScroll(document.createElement("main"), 500);
  expect(window.scrollY).toBe(100);
  view.grow(900);
  expect(window.scrollY).toBe(500);
  const calls = view.scroll.mock.calls.length;
  view.grow(1200);
  expect(view.scroll).toHaveBeenCalledTimes(calls);
  stop();
  expect(view.disconnect).toHaveBeenCalled();
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

it("releases a move toward the saved position that no clamp explains", () => {
  vi.useFakeTimers();
  const view = layout(0, 683);
  const stop = restorePageScroll(document.createElement("main"), 721);
  try {
    view.setHeight(1500);
    vi.stubGlobal("scrollY", 700);
    window.dispatchEvent(new Event("scroll"));
    const calls = view.scroll.mock.calls.length;
    vi.advanceTimersByTime(RESTORE_POLL_MS);
    expect(window.scrollY).toBe(700);
    expect(view.disconnect).toHaveBeenCalledOnce();
    expect(view.scroll).toHaveBeenCalledTimes(calls);
  } finally {
    stop();
  }
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

it.each(["pointerdown", "keydown", "wheel"])(
  "leaves the collector's position alone after %s interrupts a pending restore",
  (input) => {
    vi.useFakeTimers();
    const view = layout(0, 683);
    const stop = restorePageScroll(document.createElement("main"), 721);
    window.dispatchEvent(new Event(input));
    vi.stubGlobal("scrollY", 120);
    view.grow(1500);
    vi.advanceTimersByTime(RESTORE_POLL_MS * 3);
    expect(window.scrollY).toBe(120);
    stop();
  }
);

it("retries a later clamp even after first reaching the history position", () => {
  vi.useFakeTimers();
  const view = layout(0, 1204);
  const stop = restorePageScroll(document.createElement("main"), 721);
  try {
    expect(window.scrollY).toBe(721);
    view.setHeight(683);
    vi.stubGlobal("scrollY", 683);
    window.dispatchEvent(new Event("scroll"));
    view.setHeight(1500);
    vi.advanceTimersByTime(RESTORE_POLL_MS);
    expect(window.scrollY).toBe(721);
  } finally {
    stop();
  }
});

it.each(["pointerdown", "keydown", "wheel"])(
  "releases a reached history position and its anchoring guard on %s",
  (input) => {
    vi.useFakeTimers();
    const root = document.documentElement;
    const previous = root.style.overflowAnchor;
    const body = document.body;
    const previousBody = body.style.overflowAnchor;
    body.style.overflowAnchor = "auto";
    root.style.overflowAnchor = "auto";
    const view = layout(0, 900);
    const stop = restorePageScroll(document.createElement("main"), 500);
    try {
      expect(root.style.overflowAnchor).toBe("none");
      expect(body.style.overflowAnchor).toBe("none");
      window.dispatchEvent(new Event(input));
      expect(root.style.overflowAnchor).toBe("auto");
      expect(body.style.overflowAnchor).toBe("auto");
      vi.stubGlobal("scrollY", 120);
      view.grow(1500);
      vi.advanceTimersByTime(RESTORE_POLL_MS * 3);
      expect(window.scrollY).toBe(120);
    } finally {
      stop();
      root.style.overflowAnchor = previous;
      body.style.overflowAnchor = previousBody;
    }
  }
);

it("bounds the anchoring guard and restores its previous style exactly once", () => {
  vi.useFakeTimers();
  const root = document.documentElement;
  const previous = root.style.overflowAnchor;
  const body = document.body;
  const previousBody = body.style.overflowAnchor;
  body.style.overflowAnchor = "auto";
  root.style.overflowAnchor = "auto";
  layout(0, 900);
  const stop = restorePageScroll(document.createElement("main"), 500);
  try {
    expect(root.style.overflowAnchor).toBe("none");
    expect(body.style.overflowAnchor).toBe("none");
    vi.advanceTimersByTime(RESTORE_WINDOW_MS + RESTORE_POLL_MS * 2);
    expect(root.style.overflowAnchor).toBe("auto");
    expect(body.style.overflowAnchor).toBe("auto");
    root.style.overflowAnchor = "none";
    body.style.overflowAnchor = "none";
    stop();
    expect(root.style.overflowAnchor).toBe("none");
    expect(body.style.overflowAnchor).toBe("none");
  } finally {
    stop();
    root.style.overflowAnchor = previous;
    body.style.overflowAnchor = previousBody;
  }
});

it.each(["scroll before poll", "poll before scroll", "resize before scroll"])(
  "S5-R1 keeps a newer programmatic position: %s",
  (ordering) => {
    vi.useFakeTimers();
    const view = layout(0, 1500);
    const stop = restorePageScroll(document.createElement("main"), 721);
    try {
      expect(window.scrollY).toBe(721);
      vi.stubGlobal("scrollY", 400);
      if (ordering === "scroll before poll")
        window.dispatchEvent(new Event("scroll"));
      if (ordering === "resize before scroll") view.grow(1800);
      else vi.advanceTimersByTime(RESTORE_POLL_MS);
      window.dispatchEvent(new Event("scroll"));
      vi.advanceTimersByTime(RESTORE_POLL_MS * 2);
      expect(window.scrollY).toBe(400);
    } finally {
      stop();
    }
  }
);

it("S5-R1 still retries a native clamp when the poll precedes its scroll event", () => {
  vi.useFakeTimers();
  const view = layout(0, 1500);
  const stop = restorePageScroll(document.createElement("main"), 721);
  try {
    view.setHeight(683);
    vi.stubGlobal("scrollY", 683);
    vi.advanceTimersByTime(RESTORE_POLL_MS);
    window.dispatchEvent(new Event("scroll"));
    view.setHeight(1500);
    vi.advanceTimersByTime(RESTORE_POLL_MS);
    expect(window.scrollY).toBe(721);
  } finally {
    stop();
  }
});

it.each(["cleanup", "wheel", "expiry"])(
  "keeps both anchoring guards on html and body and restores each exactly once (%s)",
  (release) => {
    vi.useFakeTimers();
    const styles = [document.documentElement.style, document.body.style];
    const previous = styles.map((style) => style.cssText);
    styles.forEach((style) =>
      style.setProperty("overflow-anchor", "auto", "important")
    );
    const writes = styles.map((style) => vi.spyOn(style, "setProperty"));
    layout(0, 1500);
    const stop = restorePageScroll(document.createElement("main"), 721);
    try {
      for (const style of styles) {
        expect(style.getPropertyValue("overflow-anchor")).toBe("none");
        expect(style.getPropertyPriority("overflow-anchor")).toBe("important");
      }
      if (release === "cleanup") stop();
      else if (release === "wheel") window.dispatchEvent(new Event("wheel"));
      else vi.advanceTimersByTime(RESTORE_WINDOW_MS + RESTORE_POLL_MS * 2);
      styles.forEach((style, index) => {
        expect(style.getPropertyValue("overflow-anchor")).toBe("auto");
        expect(style.getPropertyPriority("overflow-anchor")).toBe("important");
        expect(writes[index]).toHaveBeenCalledTimes(2);
      });
      stop();
      writes.forEach((write) => expect(write).toHaveBeenCalledTimes(2));
    } finally {
      stop();
      styles.forEach((style, index) => {
        writes[index].mockRestore();
        style.cssText = previous[index];
      });
    }
  }
);

it("S5-R3 remembers an observed shrink before growth and the queued scroll event", () => {
  vi.useFakeTimers();
  const view = layout(0, 1500);
  // The observer runs now; its animation frame and the scroll event are still queued.
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 1)
  );
  const stop = restorePageScroll(document.createElement("main"), 721);
  try {
    expect(window.scrollY).toBe(721);
    vi.stubGlobal("scrollY", 683);
    view.grow(683);
    view.grow(1500);
    expect(window.scrollY).toBe(683);
    vi.advanceTimersByTime(RESTORE_POLL_MS);
    expect(window.scrollY).toBe(721);
    window.dispatchEvent(new Event("scroll"));
    vi.advanceTimersByTime(RESTORE_POLL_MS);
    expect(window.scrollY).toBe(721);
  } finally {
    stop();
  }
});

it("S5-R3 retains every observed short end until the next owned write", () => {
  vi.useFakeTimers();
  const view = layout(0, 1500);
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 1)
  );
  const stop = restorePageScroll(document.createElement("main"), 721);
  try {
    vi.stubGlobal("scrollY", 683);
    view.grow(683);
    view.grow(700);
    view.grow(1500);
    vi.advanceTimersByTime(RESTORE_POLL_MS);
    expect(window.scrollY).toBe(721);
    // The old short end cannot explain a new app scroll after our owned write.
    vi.stubGlobal("scrollY", 683);
    vi.advanceTimersByTime(RESTORE_POLL_MS);
    expect(window.scrollY).toBe(683);
    expect(view.disconnect).toHaveBeenCalledOnce();
  } finally {
    stop();
  }
});

it("S5-R3 releases a shrink and growth with no observable layout or scroll delivery", () => {
  vi.useFakeTimers();
  const view = layout(0, 1500);
  const stop = restorePageScroll(document.createElement("main"), 721);
  try {
    // No observer, rendering step, poll or scroll handler sees the short page.
    // This is indistinguishable from an app scroll to 683, so ownership releases.
    view.setHeight(683);
    vi.stubGlobal("scrollY", 683);
    view.setHeight(1500);
    vi.advanceTimersByTime(RESTORE_POLL_MS);
    window.dispatchEvent(new Event("scroll"));
    vi.advanceTimersByTime(RESTORE_POLL_MS);
    expect(window.scrollY).toBe(683);
    expect(view.disconnect).toHaveBeenCalledOnce();
  } finally {
    stop();
  }
});

it("S5-R3 does not treat every position above a historical end as a clamp", () => {
  vi.useFakeTimers();
  const view = layout(0, 1500);
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 1)
  );
  const stop = restorePageScroll(document.createElement("main"), 721);
  try {
    vi.stubGlobal("scrollY", 300);
    view.grow(300);
    view.grow(1500);
    vi.stubGlobal("scrollY", 400);
    vi.advanceTimersByTime(RESTORE_POLL_MS);
    expect(window.scrollY).toBe(400);
    expect(view.disconnect).toHaveBeenCalledOnce();
  } finally {
    stop();
  }
});

it("restores the phone Want List position through a clamp and later growth", () => {
  vi.useFakeTimers();
  const styles = [document.documentElement.style, document.body.style];
  const previous = styles.map((style) => style.cssText);
  styles.forEach((style) => style.setProperty("overflow-anchor", "auto"));
  const view = layout(0, 1468);
  const stop = restorePageScroll(document.createElement("main"), 1498);
  try {
    view.grow(1520);
    view.grow(1917);
    vi.advanceTimersByTime(RESTORE_POLL_MS * 2);
    expect(window.scrollY).toBe(1498);
    expect(view.disconnect).not.toHaveBeenCalled();
    styles.forEach((style) => expect(style.overflowAnchor).toBe("none"));
    vi.advanceTimersByTime(RESTORE_WINDOW_MS - RESTORE_POLL_MS * 2);
    expect(view.disconnect).not.toHaveBeenCalled();
    vi.advanceTimersByTime(RESTORE_POLL_MS);
    expect(view.disconnect).toHaveBeenCalledOnce();
    styles.forEach((style) => expect(style.overflowAnchor).toBe("auto"));
  } finally {
    stop();
    styles.forEach((style, index) => {
      style.cssText = previous[index];
    });
  }
});

it.each(["scroll", "poll", "resize"])(
  "releases a later scroll past a reached target after an earlier clamp (%s first)",
  (ordering) => {
    vi.useFakeTimers();
    const view = layout(0, 450);
    const stop = restorePageScroll(document.createElement("main"), 500);
    try {
      expect(window.scrollY).toBe(450);
      view.setHeight(1000);
      vi.advanceTimersByTime(RESTORE_POLL_MS);
      expect(window.scrollY).toBe(500);
      view.setHeight(1400);
      vi.stubGlobal("scrollY", 900);
      const calls = view.scroll.mock.calls.length;
      if (ordering === "scroll") window.dispatchEvent(new Event("scroll"));
      else if (ordering === "poll") vi.advanceTimersByTime(RESTORE_POLL_MS);
      else view.grow(1400);
      window.dispatchEvent(new Event("scroll"));
      vi.advanceTimersByTime(RESTORE_POLL_MS * 2);
      expect(window.scrollY).toBe(900);
      expect(view.disconnect).toHaveBeenCalledOnce();
      expect(view.scroll).toHaveBeenCalledTimes(calls);
    } finally {
      stop();
    }
  }
);

it("consumes clamp evidence once the target is reached", () => {
  vi.useFakeTimers();
  const view = layout(0, 1000);
  const stop = restorePageScroll(document.createElement("main"), 500);
  try {
    view.setHeight(450);
    vi.stubGlobal("scrollY", 450);
    window.dispatchEvent(new Event("scroll"));
    expect(view.disconnect).not.toHaveBeenCalled();
    view.setHeight(1000);
    vi.advanceTimersByTime(RESTORE_POLL_MS);
    expect(window.scrollY).toBe(500);
    vi.stubGlobal("scrollY", 450);
    window.dispatchEvent(new Event("scroll"));
    const calls = view.scroll.mock.calls.length;
    vi.advanceTimersByTime(RESTORE_POLL_MS);
    expect(window.scrollY).toBe(450);
    expect(view.disconnect).toHaveBeenCalledOnce();
    expect(view.scroll).toHaveBeenCalledTimes(calls);
  } finally {
    stop();
  }
});

it("does not reuse reconciled growth to claim a later unrelated scroll", () => {
  vi.useFakeTimers();
  const view = layout(0, 1520);
  const stop = restorePageScroll(document.createElement("main"), 1498);
  try {
    view.grow(1917);
    vi.stubGlobal("scrollY", 1895);
    window.dispatchEvent(new Event("scroll"));
    vi.advanceTimersByTime(RESTORE_POLL_MS);
    expect(window.scrollY).toBe(1895);
    expect(view.disconnect).toHaveBeenCalledOnce();
  } finally {
    stop();
  }
});

it("releases a scroll matching document growth when restoration never clamped", () => {
  vi.useFakeTimers();
  const view = layout(0, 1000);
  const stop = restorePageScroll(document.createElement("main"), 500);
  try {
    view.setHeight(1400);
    vi.stubGlobal("scrollY", 900);
    window.dispatchEvent(new Event("scroll"));
    vi.advanceTimersByTime(RESTORE_POLL_MS);
    expect(window.scrollY).toBe(900);
    expect(view.disconnect).toHaveBeenCalledOnce();
  } finally {
    stop();
  }
});

it("keeps restoring while the page marks itself loading, then for the window after", () => {
  vi.useFakeTimers();
  const view = layout(0, 100);
  const page = document.createElement("main");
  page.innerHTML = "<p data-page-loading>Loading</p>";
  document.body.append(page);
  const stop = restorePageScroll(page, 500);
  vi.advanceTimersByTime(RESTORE_WINDOW_MS * 2);
  view.setHeight(900);
  vi.advanceTimersByTime(RESTORE_POLL_MS);
  expect(window.scrollY).toBe(500);
  // Loading ends; the window now counts from here.
  page.replaceChildren();
  vi.advanceTimersByTime(RESTORE_POLL_MS);
  view.setHeight(100);
  vi.advanceTimersByTime(RESTORE_WINDOW_MS - RESTORE_POLL_MS * 2);
  view.setHeight(900);
  vi.advanceTimersByTime(RESTORE_POLL_MS * 2);
  expect(window.scrollY).toBe(500);
  vi.advanceTimersByTime(RESTORE_WINDOW_MS + RESTORE_POLL_MS * 2);
  const calls = view.scroll.mock.calls.length;
  vi.advanceTimersByTime(RESTORE_POLL_MS * 5);
  expect(view.scroll).toHaveBeenCalledTimes(calls);
  stop();
  page.remove();
});

it("ignores a loading marker inside a hidden or inert subtree", () => {
  vi.useFakeTimers();
  const view = layout(0, 100);
  const page = document.createElement("main");
  page.innerHTML =
    '<div hidden><p data-page-loading>x</p></div><div inert><h1 data-page-heading="loading">y</h1></div>';
  document.body.append(page);
  const stop = restorePageScroll(page, 500);
  vi.advanceTimersByTime(RESTORE_WINDOW_MS + RESTORE_POLL_MS * 2);
  const calls = view.scroll.mock.calls.length;
  view.setHeight(900);
  vi.advanceTimersByTime(RESTORE_POLL_MS * 5);
  expect(view.scroll).toHaveBeenCalledTimes(calls);
  stop();
  page.remove();
});

for (const input of ["pointerdown", "keydown", "wheel", "touchstart"])
  it(`a page that never stops loading still releases on ${input}`, () => {
    vi.useFakeTimers();
    const view = layout(0, 100);
    const page = document.createElement("main");
    page.innerHTML = "<p data-page-loading>Loading</p>";
    document.body.append(page);
    restorePageScroll(page, 500);
    vi.advanceTimersByTime(RESTORE_WINDOW_MS * 2);
    window.dispatchEvent(new Event(input));
    const calls = view.scroll.mock.calls.length;
    view.setHeight(900);
    vi.advanceTimersByTime(RESTORE_POLL_MS * 5);
    expect(view.scroll).toHaveBeenCalledTimes(calls);
    page.remove();
  });

it("a page that never stops loading releases on cleanup", () => {
  vi.useFakeTimers();
  const view = layout(0, 100);
  const page = document.createElement("main");
  page.innerHTML = "<p data-page-loading>Loading</p>";
  document.body.append(page);
  const stop = restorePageScroll(page, 500);
  vi.advanceTimersByTime(RESTORE_WINDOW_MS * 2);
  stop();
  const calls = view.scroll.mock.calls.length;
  view.setHeight(900);
  vi.advanceTimersByTime(RESTORE_POLL_MS * 5);
  expect(view.scroll).toHaveBeenCalledTimes(calls);
  page.remove();
});
