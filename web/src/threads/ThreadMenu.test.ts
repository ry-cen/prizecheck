// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { blockTrader } from "../social_generated";
import { ThreadMenu } from "./ThreadMenu";
vi.mock("../social_generated", async (original) => ({
  ...(await original<typeof import("../social_generated")>()),
  getTradeViews: vi.fn(async () => []),
  blockTrader: vi.fn(async () => ({ relation: "blocked" })),
}));
it("keeps Block's question, explicit confirmation and return focus in item chat", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(
    1000
  );
  vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(
    1000
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(10, 10, 30, 30)
  );
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const changed = vi.fn();
  try {
    await act(async () =>
      root.render(
        h(ThreadMenu, {
          target: { traderId: "public-trader", name: "Misty", handle: null },
          canMessage: true,
          canReport: true,
          offerId: "offer",
          onChanged: changed,
        })
      )
    );
    const more = host.querySelector("button")!;
    await act(async () => more.click());
    const block = [
      ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ].find((node) => node.textContent === "Block")!;
    expect(block, host.innerHTML).toBeDefined();
    await act(async () => block.click());
    expect(host.textContent).toContain("Block Misty? They won't be told.");
    expect(blockTrader).not.toHaveBeenCalled();
    const confirm = [...host.querySelectorAll("button")].find(
      (node) => node.textContent === "Block"
    )!;
    expect(document.activeElement).toBe(confirm);
    await act(async () => confirm.click());
    expect(blockTrader).toHaveBeenCalledWith(
      "public-trader",
      expect.objectContaining({ idempotency_key: expect.any(String) })
    );
    expect(changed).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[role="status"]')?.textContent).toBe(
      "Blocked Misty. They aren't told."
    );
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  }
});
