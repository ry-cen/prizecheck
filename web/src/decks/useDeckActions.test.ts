// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import type { DeckDetail } from "../decks_generated";
import { useDeckActions } from "./useDeckActions";

vi.mock("../ui/Toast", () => ({ useToast: () => ({}) }));
vi.mock("./publication", () => ({
  usePublication: () => ({ read: { kind: "loading" } }),
  publishBlock: () => null,
}));

let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement;
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
});

for (const [countReady, count, disabled] of [
  [false, "60", true],
  [true, "59", false],
  [true, "0", true],
] as const) {
  test(`Buy missing readiness=${countReady}, count=${count}`, async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    function Harness({ ready = countReady }: { ready?: boolean }) {
      const actions = useDeckActions({
        deckId: "deck",
        detail: {
          to_get: count,
          deck: { id: "deck", name: "Weekend" },
          checks: { total: count },
        } as DeckDetail,
        countReady: ready,
        result: null,
        target: "standard",
        read() {},
        onAllDecks() {},
        onReplaceList() {},
      });
      return actions.buyMissing;
    }
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root!.render(createElement(Harness)));
    const button = host.querySelector("button")!;
    expect(button.disabled).toBe(disabled);
    if (!countReady) {
      const reason = document.getElementById(
        button.getAttribute("aria-describedby")!
      );
      expect(reason?.classList.contains("sr-only")).toBe(false);
      expect(reason?.textContent).toBe("Wait for this Deck's missing count.");
      await act(async () =>
        root!.render(createElement(Harness, { ready: true }))
      );
      expect(host.querySelector("button")!.disabled).toBe(false);
      expect(
        host.querySelector("button")!.hasAttribute("aria-describedby")
      ).toBe(false);
      expect(document.getElementById(reason!.id)).toBeNull();
    }
  });
}
