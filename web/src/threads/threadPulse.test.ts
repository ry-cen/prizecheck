// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { usePulse, PULSE_SLOW_MS } from "../inbox/usePulse";
import { threadPulse } from "./threadPulse";
const valid = {
  trades: { needs_you: 3, waiting: 2, unread: 2 },
  loans: { needs_you: 1, waiting: 1, unread: 0 },
  watermark: "first",
};
it.each([
  null,
  [],
  { locations: [], nodes: [], owner_revision: 1 },
  { ...valid, trades: null },
  { ...valid, loans: [] },
  { ...valid, watermark: null },
  { ...valid, trades: { needs_you: "3", waiting: 2, unread: 2 } },
  { ...valid, trades: { needs_you: -1, waiting: 0, unread: 0 } },
  { ...valid, trades: { needs_you: 2.5, waiting: 2, unread: 2 } },
  { ...valid, trades: { needs_you: 1, waiting: 2, unread: 2 } },
  { ...valid, trades: { needs_you: 5, waiting: 2, unread: 2 } },
])(
  "rejects malformed pulse data without inventing badge counts: %j",
  (value) => {
    expect(threadPulse(value)).toBeNull();
  }
);
it("keeps distinct waiting, unread and their valid union, including optional zero defaults", () => {
  expect(threadPulse(valid)).toEqual(valid);
  expect(threadPulse({ trades: {}, loans: {}, watermark: "empty" })).toEqual({
    trades: { needs_you: 0, waiting: 0, unread: 0 },
    loans: { needs_you: 0, waiting: 0, unread: 0 },
    watermark: "empty",
  });
});
it.each([false, true])(
  "keeps navigation counts valid after malformed HTTP200 and recovers normally (first=%s)",
  async (first) => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("visible");
    const malformed = { locations: [], nodes: [], owner_revision: 1 };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json(first ? malformed : valid))
      .mockResolvedValueOnce(Response.json(first ? valid : malformed))
      .mockResolvedValueOnce(
        Response.json({
          ...valid,
          trades: { needs_you: 4, waiting: 2, unread: 2 },
          watermark: "next",
        })
      );
    vi.stubGlobal("fetch", fetch);
    const changed = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    function View() {
      const pulse = usePulse(false, changed);
      return h(
        "div",
        null,
        JSON.stringify({ trades: pulse.trades, loans: pulse.loans })
      );
    }
    try {
      await act(async () => root.render(h(View)));
      const before = host.textContent;
      expect(before).toContain(first ? '"needs_you":0' : '"needs_you":3');
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
      });
      if (!first) expect(host.textContent).toBe(before);
      expect(host.textContent).toContain('"needs_you":3');
      expect(changed).not.toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledTimes(2);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(PULSE_SLOW_MS);
      });
      expect(host.textContent).toContain('"needs_you":4');
      expect(changed).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledTimes(3);
    } finally {
      await act(async () => root.unmount());
      host.remove();
      visibility.mockRestore();
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  }
);

it.each([false, true])(
  "reports malformed pulses once per page session, never valid pulses (malformed=%s)",
  async (malformed) => {
    vi.resetModules();
    const { usePulse: useSessionPulse, PULSE_SLOW_MS: interval } =
      await import("../inbox/usePulse");
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("visible");
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetch = vi
      .fn()
      .mockImplementation(async () =>
        Response.json(malformed ? { secret: "must not be logged" } : valid)
      );
    vi.stubGlobal("fetch", fetch);
    const host = document.createElement("div");
    document.body.append(host);
    let root = createRoot(host);
    function View() {
      const pulse = useSessionPulse(false, () => {});
      return h("span", null, pulse.trades.needs_you);
    }
    try {
      await act(async () => root.render(h(View)));
      await act(async () => window.dispatchEvent(new Event("focus")));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(interval);
      });
      await act(async () => root.unmount());
      root = createRoot(host);
      await act(async () => root.render(h(View)));
      expect(fetch).toHaveBeenCalledTimes(4);
      expect(host.textContent).toBe(malformed ? "0" : "3");
      expect(diagnostic).toHaveBeenCalledTimes(malformed ? 1 : 0);
      if (malformed)
        expect(diagnostic).toHaveBeenCalledWith(
          "Invalid thread pulse response; retaining the last valid counts."
        );
    } finally {
      await act(async () => root.unmount());
      host.remove();
      diagnostic.mockRestore();
      visibility.mockRestore();
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  }
);
