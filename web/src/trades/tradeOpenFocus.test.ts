// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { TradesPage } from "./TradesPage";

const ID = "0d01c839-0000-4000-8000-000000000001";
const shown: { tradeId: string | null; focusOnOpen?: boolean }[] = [];
let openRow: (id: string) => void = () => {};
vi.mock("./TradeScreen", () => ({
  TradeScreen: (props: { tradeId: string | null; focusOnOpen?: boolean }) => {
    shown.push(props);
    return null;
  },
}));
vi.mock("../threads/ThreadList", () => ({
  ThreadList: ({ onOpen }: { onOpen: (id: string) => void }) => {
    openRow = onOpen;
    return null;
  },
}));

it("a Trade takes headline focus only when an in-app press opened it, never on Back, Forward or a direct load", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  const onNavigate = vi.fn();
  const root = createRoot(document.createElement("div"));
  const at = (section: string | null) =>
    act(async () =>
      root.render(h(TradesPage, { active: true, section, onNavigate }))
    );
  const last = () => shown.at(-1)!;
  try {
    await at(ID);
    expect(last()).toMatchObject({ tradeId: ID, focusOnOpen: false });
    await at(null);
    openRow(ID);
    expect(onNavigate).toHaveBeenCalledWith(`/trades/${ID}`, undefined);
    await at(ID);
    expect(last()).toMatchObject({ tradeId: ID, focusOnOpen: true });
    // Counter, then Back to the Trade, then Back to the list and Forward to the Trade: no press opened it.
    await at(`${ID}/counter`);
    await at(ID);
    expect(last().focusOnOpen).toBe(false);
    await at(null);
    await at(ID);
    expect(last().focusOnOpen).toBe(false);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
