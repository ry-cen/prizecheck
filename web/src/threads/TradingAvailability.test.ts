// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { getDiscovery } from "../social_generated";
import { TradingAvailability } from "./TradingAvailability";
vi.mock("../social_generated", () => ({ getDiscovery: vi.fn() }));
it.each(["on", "suspended"] as const)(
  "states only the reader's own standing (%s)",
  async (status) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.mocked(getDiscovery).mockResolvedValue({
      status,
      zip: null,
      radius_mi: 5,
      zip_changes_left: 0,
      visible_beyond_friends: false,
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () =>
        root.render(h(TradingAvailability, { enabled: false, revision: "0" }))
      );
      expect(getDiscovery).not.toHaveBeenCalled();
      expect(host.textContent).toBe("");
      await act(async () =>
        root.render(h(TradingAvailability, { enabled: true, revision: "0" }))
      );
      expect(getDiscovery).toHaveBeenCalledTimes(1);
      expect(host.textContent).toBe(
        status === "suspended"
          ? "Your account can't trade or message right now."
          : ""
      );
      await act(async () =>
        root.render(h(TradingAvailability, { enabled: false, revision: "0" }))
      );
      expect(host.textContent).toBe("");
    } finally {
      await act(async () => root.unmount());
      host.remove();
      vi.unstubAllGlobals();
      vi.clearAllMocks();
    }
  }
);
