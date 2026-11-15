// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";
import { focusTradeWants, TradeWantsShortcut } from "./TradeWantsPanel";
import type { TradeWantsApi } from "./useTradeWants";

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

it("offers a shortcut before the first Trade Want", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const api = {
    state: {
      kind: "ready",
      wants: { lines: [], will_accept: [] },
      rules: new Map(),
    },
  } as unknown as TradeWantsApi;
  await act(async () => root.render(h(TradeWantsShortcut, { api })));
  expect(host.querySelector("a")?.textContent).toBe("Add a Trade Want");
  await act(async () => root.unmount());
  host.remove();
});

it("focuses Add a card, falling back to the heading only when absent", () => {
  document.body.innerHTML =
    '<h2 id="trade-wants" tabindex="-1">Trade Wants</h2><button id="trade-wants-add">Add a card</button>';
  const heading = document.getElementById("trade-wants")!;
  const add = document.getElementById("trade-wants-add")!;
  add.scrollIntoView = vi.fn();
  heading.scrollIntoView = vi.fn();
  focusTradeWants();
  expect(document.activeElement).toBe(add);
  expect(add.scrollIntoView).toHaveBeenCalled();
  add.remove();
  focusTradeWants();
  expect(document.activeElement).toBe(heading);
  document.body.innerHTML = "";
});
