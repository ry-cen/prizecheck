// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { CatalogGallery } from "./CatalogGallery";
import type { CatalogCard, CatalogView } from "./catalogUrl";
import { ToastProvider } from "../ui/Toast";

const json = (value: unknown) => new Response(JSON.stringify(value));
const P1 = "0a1b2c3d-0000-4000-8000-0000000000a1";
const P2 = "0a1b2c3d-0000-4000-8000-0000000000a2";
const E1 = "0a1b2c3d-0000-4000-8000-0000000000e1";
const E2 = "0a1b2c3d-0000-4000-8000-0000000000e2";
const E3 = "0a1b2c3d-0000-4000-8000-0000000000e3";
const standing = Object.fromEntries(
  ["standard", "expanded", "glc"].map((key) => [
    key,
    { status: "legal", reasons: [] },
  ])
);
const row = (edition: string, printing: string, name: string) => ({
  edition_id: edition,
  printing_id: printing,
  name,
  set_id: "set",
  set_name: "Set",
  set_code: "SET",
  collector_number: "1",
  descriptor: { finish: "normal" },
  image_url: null,
  art_url: null,
  card_kind: "trainer",
  trainer_type: "item",
  owned: 0,
  in_deck: 0,
  free: 0,
  standing,
});
const TWO = [row(E1, P1, "Switch"), row(E2, P2, "Potion")];
let ROWS = TWO;
/** While set, the results list (not a card's own Editions) waits for it, so a card can close before the results land. */
let GATE: Promise<void> | null = null;
/** While set, a Printing's own details wait for it, so a Printing-only card can close before its Edition is known. */
let PRINTING_GATE: Promise<void> | null = null;
/** True: the results list answers "unavailable", so the page has no results line. */
let UNAVAILABLE = false;
/** True: the Set lookup fails, so a Catalog address naming a Set never lets its results start. */
let SETS_FAIL = false;
const PRINTINGS: Record<string, { name: string; editions: string[] }> = {
  [P1]: { name: "Switch", editions: [E1, E3] },
  [P2]: { name: "Potion", editions: [E2] },
};

function stubBrowser() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("CSS", { escape: (s: string) => s });
  const noop = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  vi.stubGlobal("ResizeObserver", noop);
  vi.stubGlobal("IntersectionObserver", noop);
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
    {},
  ] as unknown as DOMRectList);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      const printing = /\/printings\/([^/?]+)/.exec(url.pathname)?.[1];
      if (printing && PRINTINGS[printing]) {
        if (PRINTING_GATE) await PRINTING_GATE;
        return json({
          printing: {
            id: printing,
            name: PRINTINGS[printing].name,
            identity_name: PRINTINGS[printing].name,
            editions: PRINTINGS[printing].editions.map((id) => ({
              id,
              active: true,
              descriptor: { finish: id === E3 ? "holo" : "normal" },
            })),
          },
        });
      }
      if (url.pathname.includes("location-tree"))
        return json({ locations: [] });
      if (url.pathname.endsWith("/editions")) {
        const only = url.searchParams.get("printing_id");
        if (!only && GATE) await GATE;
        if (!only && UNAVAILABLE)
          return json({
            available: false,
            matches: 0,
            search: { mode: "all" },
            editions: [],
            next_cursor: null,
            catalog_revision: 1,
            owner_revision: 1,
          });
        return json({
          available: true,
          matches: ROWS.length,
          search: { mode: "all" },
          editions: ROWS.filter((r) => !only || r.printing_id === only),
          next_cursor: null,
          catalog_revision: 1,
          owner_revision: 1,
        });
      }
      if (url.pathname.includes("/sets")) {
        if (SETS_FAIL) return new Response("", { status: 500 });
        return json({ available: true, sets: [] });
      }
      return json({
        available: true,
        revision: 1,
        owner_revision: 1,
        holdings: [],
        friends: [],
        prices: [],
      });
    })
  );
}

async function mount(
  initial: CatalogCard | null | undefined,
  initialView?: CatalogView
) {
  stubBrowser();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const onCardRoute = vi.fn();
  const render = (props: {
    routeCard?: CatalogCard | null;
    active?: boolean;
    view?: CatalogView;
  }) =>
    act(async () =>
      root.render(
        h(
          ToastProvider,
          null,
          h(CatalogGallery, {
            active: props.active ?? true,
            adding: false,
            fixedTarget: null,
            undoToast: true,
            stick: "page",
            routeCard: props.routeCard,
            view: props.view ?? initialView,
            onViewChange: props.view || initialView ? () => {} : undefined,
            onCardRoute:
              props.routeCard === undefined ? undefined : onCardRoute,
          })
        )
      )
    );
  await render({ routeCard: initial, view: initialView });
  const dialog = () => host.querySelector<HTMLDialogElement>("dialog[open]");
  const tile = (id: string) =>
    host.querySelector<HTMLButtonElement>(`[data-edition-id="${id}"] button`)!;
  const button = (name: string) =>
    [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) =>
        b.textContent?.startsWith(name) || b.getAttribute("aria-label") === name
    )!;
  const done = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  return { host, render, onCardRoute, dialog, tile, button, done };
}

afterEach(() => {
  ROWS = TWO;
  GATE = null;
  PRINTING_GATE = null;
  UNAVAILABLE = false;
  SETS_FAIL = false;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("a tile click asks the page to open the card and opens nothing itself", async () => {
  const g = await mount(null);
  try {
    await act(async () => g.tile(E1).click());
    expect(g.onCardRoute).toHaveBeenCalledWith(
      { printingId: P1, editionId: E1 },
      "open"
    );
    expect(g.dialog()).toBeNull();
  } finally {
    await g.done();
  }
});

test("supplying the card opens the dialog on that row, and stepping replaces", async () => {
  const g = await mount(null);
  try {
    await g.render({ routeCard: { printingId: P1, editionId: E1 } });
    expect(g.dialog()).not.toBeNull();
    expect(g.dialog()!.textContent).toContain("Switch");
    await act(async () => g.button("Next card").click());
    expect(g.onCardRoute).toHaveBeenLastCalledWith(
      { printingId: P2, editionId: E2 },
      "replace"
    );
    // The dialog still shows the first card until the address says otherwise.
    expect(g.dialog()!.textContent).toContain("Switch");
    await g.render({ routeCard: { printingId: P2, editionId: E2 } });
    expect(g.dialog()!.textContent).toContain("Potion");
  } finally {
    await g.done();
  }
});

test("picking an Edition replaces the address and an echo keeps the typed report", async () => {
  const g = await mount({ printingId: P1, editionId: E1 });
  try {
    await act(async () => g.button("Report this Edition").click());
    const text = () => g.host.querySelector<HTMLTextAreaElement>("textarea")!;
    const field = text();
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value"
      )!.set!.call(field, "wrong finish");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    g.onCardRoute.mockClear();
    const holo = [...g.dialog()!.querySelectorAll("button[aria-pressed]")].find(
      (b) => b.getAttribute("aria-pressed") === "false"
    ) as HTMLButtonElement;
    await act(async () => holo.click());
    expect(g.onCardRoute).toHaveBeenCalledWith(
      { printingId: P1, editionId: E3 },
      "replace"
    );
    // The page echoes the replaced address back as the route.
    await g.render({ routeCard: { printingId: P1, editionId: E3 } });
    expect(g.dialog()).not.toBeNull();
    expect(text().value).toBe("wrong finish");
    expect(
      g.dialog()!.querySelector('button[aria-pressed="true"]')?.textContent
    ).toContain("Holo");
  } finally {
    await g.done();
  }
});

test("the route going null closes the dialog and focuses the last tile", async () => {
  const g = await mount({ printingId: P1, editionId: E1 });
  try {
    expect(g.dialog()).not.toBeNull();
    await g.render({ routeCard: null });
    expect(g.dialog()).toBeNull();
    expect(document.activeElement).toBe(g.tile(E1));
    expect(g.onCardRoute).not.toHaveBeenCalledWith(null, "close");
  } finally {
    await g.done();
  }
});

test("a hidden page closes the card and writes nothing", async () => {
  const g = await mount({ printingId: P1, editionId: E1 });
  try {
    expect(g.dialog()).not.toBeNull();
    g.onCardRoute.mockClear();
    await g.render({
      routeCard: { printingId: P1, editionId: E1 },
      active: false,
    });
    expect(g.dialog()).toBeNull();
    expect(g.onCardRoute).not.toHaveBeenCalled();
    await g.render({
      routeCard: { printingId: P1, editionId: E1 },
      active: true,
    });
    expect(g.dialog()).not.toBeNull();
  } finally {
    await g.done();
  }
});

test("closing the dialog asks the page to close the card", async () => {
  const g = await mount({ printingId: P1, editionId: E1 });
  try {
    await act(async () => g.button("Close card details").click());
    expect(g.onCardRoute).toHaveBeenCalledWith(null, "close");
    expect(g.dialog()).not.toBeNull();
  } finally {
    await g.done();
  }
});

test("without a route a tile click opens the card locally", async () => {
  const g = await mount(undefined);
  try {
    await act(async () => g.tile(E1).click());
    expect(g.dialog()).not.toBeNull();
    expect(g.onCardRoute).not.toHaveBeenCalled();
  } finally {
    await g.done();
  }
});

test("after a pick, › still steps on from the tile the card was opened from", async () => {
  // E3 (the Edition picked) is also the next tile: stepping moves on to it, then past it.
  ROWS = [TWO[0], row(E3, P1, "Switch holo"), TWO[1]];
  const g = await mount({ printingId: P1, editionId: E1 });
  try {
    const pick = [
      ...g
        .dialog()!
        .querySelectorAll<HTMLButtonElement>("button[aria-pressed]"),
    ].find((b) => b.getAttribute("aria-pressed") === "false")!;
    await act(async () => pick.click());
    await g.render({ routeCard: { printingId: P1, editionId: E3 } });
    g.onCardRoute.mockClear();
    await act(async () => g.button("Next card").click());
    await g.render({ routeCard: { printingId: P1, editionId: E3 } });
    await act(async () => g.button("Next card").click());
    expect(g.onCardRoute).toHaveBeenLastCalledWith(
      { printingId: P2, editionId: E2 },
      "replace"
    );
  } finally {
    await g.done();
  }
});

test("the route going null with no tile for the card leaves focus on the results line, not the page body", async () => {
  // E3 is Switch's Holo Edition: its card opens, but the results hold only E1 and E2.
  const g = await mount({ printingId: P1, editionId: E3 });
  try {
    expect(g.dialog()).not.toBeNull();
    expect(g.host.querySelector(`[data-edition-id="${E3}"]`)).toBeNull();
    await g.render({ routeCard: null });
    expect(g.dialog()).toBeNull();
    const line = g.host.querySelector<HTMLElement>(
      '[aria-label="Catalog results"] > p'
    );
    expect(line?.textContent).toMatch(/^Showing 2 of 2 cards$/);
    expect(document.activeElement).toBe(line);
  } finally {
    await g.done();
  }
});

test("a card that closes before the results have loaded returns focus to its tile once they do, and leaves later focus alone", async () => {
  let release = () => {};
  GATE = new Promise<void>((resolve) => (release = resolve));
  const g = await mount({ printingId: P1, editionId: E1 });
  try {
    expect(g.dialog()).not.toBeNull();
    expect(g.host.querySelector(`[data-edition-id="${E1}"]`)).toBeNull();
    await g.render({ routeCard: null });
    expect(g.dialog()).toBeNull();
    await act(async () => release());
    expect(document.activeElement).toBe(g.tile(E1));
  } finally {
    await g.done();
  }
});

test("a card that closes before the results have loaded does not pull focus from a control the collector moved to", async () => {
  let release = () => {};
  GATE = new Promise<void>((resolve) => (release = resolve));
  const g = await mount({ printingId: P1, editionId: E1 });
  try {
    await g.render({ routeCard: null });
    // Focus went to the search field when the card closed; the collector then moves it to another control.
    expect(document.activeElement).toBe(
      g.host.querySelector('input[type="search"]')
    );
    const elsewhere = [
      ...g.host.querySelectorAll<HTMLButtonElement>("button"),
    ].find((b) => b.textContent === "Standard")!;
    elsewhere.focus();
    await act(async () => release());
    expect(document.activeElement).toBe(elsewhere);
  } finally {
    await g.done();
  }
});

test("a Printing-only card that closes before its Edition is known leaves focus on the results line, not the page body", async () => {
  let release = () => {};
  PRINTING_GATE = new Promise<void>((resolve) => (release = resolve));
  const g = await mount({ printingId: P1, editionId: null });
  try {
    expect(g.dialog()).not.toBeNull();
    await g.render({ routeCard: null });
    expect(g.dialog()).toBeNull();
    await act(async () => release());
    const line = g.host.querySelector<HTMLElement>(
      '[aria-label="Catalog results"] > p'
    );
    expect(line).not.toBeNull();
    expect(document.activeElement).toBe(line);
  } finally {
    await g.done();
  }
});

test("a card that closes when the results never load leaves focus on the search field, not the page body", async () => {
  UNAVAILABLE = true;
  const g = await mount({ printingId: P1, editionId: E1 });
  try {
    expect(g.dialog()).not.toBeNull();
    expect(g.host.querySelector('[aria-label="Catalog results"]')).toBeNull();
    await g.render({ routeCard: null });
    expect(g.dialog()).toBeNull();
    expect(document.activeElement).toBe(
      g.host.querySelector('input[type="search"]')
    );
  } finally {
    await g.done();
  }
});

const search = (g: { host: HTMLElement }) =>
  g.host.querySelector<HTMLInputElement>('input[type="search"]');

test("a card that closes while the results are still loading puts focus on the search field at once, before they arrive", async () => {
  let release = () => {};
  GATE = new Promise<void>((resolve) => (release = resolve));
  const g = await mount({ printingId: P1, editionId: E1 });
  try {
    await g.render({ routeCard: null });
    expect(g.dialog()).toBeNull();
    expect(document.activeElement).toBe(search(g));
    await act(async () => release());
    expect(document.activeElement).toBe(g.tile(E1));
  } finally {
    await g.done();
  }
});

test("a tile that arrives after the query changed does not take focus", async () => {
  let release = () => {};
  GATE = new Promise<void>((resolve) => (release = resolve));
  const view: CatalogView = {
    q: "",
    format: null,
    kind: null,
    setId: null,
    owned: false,
    mode: null,
  };
  const g = await mount({ printingId: P1, editionId: E1 }, view);
  try {
    await g.render({ routeCard: null, view });
    expect(document.activeElement).toBe(search(g));
    // Filtering to owned cards is a new query: the parked return no longer applies.
    await g.render({ routeCard: null, view: { ...view, owned: true } });
    await act(async () => release());
    expect(document.activeElement).toBe(search(g));
  } finally {
    await g.done();
  }
});

test("a failed Set lookup, which leaves the results loading for good, still puts focus on the search field", async () => {
  SETS_FAIL = true;
  const view: CatalogView = {
    q: "",
    format: null,
    kind: null,
    setId: "base",
    owned: false,
    mode: null,
  };
  const g = await mount({ printingId: P1, editionId: E1 }, view);
  try {
    expect(g.dialog()).not.toBeNull();
    await g.render({ routeCard: null, view });
    expect(g.dialog()).toBeNull();
    expect(g.host.querySelector('[aria-label="Catalog results"]')).toBeNull();
    expect(document.activeElement).toBe(search(g));
    expect(document.activeElement).not.toBe(document.body);
  } finally {
    await g.done();
  }
});

test("resolving the results after the page is gone throws nothing and moves no focus", async () => {
  let release = () => {};
  GATE = new Promise<void>((resolve) => (release = resolve));
  const g = await mount({ printingId: P1, editionId: E1 });
  await g.render({ routeCard: null });
  expect(document.activeElement).toBe(search(g));
  await g.done();
  const before = document.activeElement;
  await act(async () => release());
  expect(document.activeElement).toBe(before);
});
