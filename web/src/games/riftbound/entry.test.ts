import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { RiftboundApp } from "./RiftboundApp";
import { collectionFixtureReader } from "./local/collectionFixtures";
import { deckFixture } from "./local/deckFixtures";
import { fixtureReader } from "./local/fixtures";

const collectionHash =
  "#riftbound:section=collection&location=all&collectionSearch=&collectionPage=1&view=catalog&edition=&page=1";
const decksHash =
  "#riftbound:section=decks&deck=&deckTab=deck&location=all&collectionSearch=&collectionPage=1&view=catalog&edition=&page=1";
const decksContent = () => document.querySelector("[data-decks-content]");
const catalogSearch = () =>
  document.querySelector('[aria-label="Search cards"]');
const collectionResults = () =>
  document.querySelector('section[aria-label="Collection results"]');

type Mounted = {
  dom: JSDOM;
  render: (props?: Record<string, unknown>) => Promise<void>;
  unmount: () => Promise<void>;
};
async function mount(
  hash: string,
  props: Record<string, unknown>,
  state?: unknown
): Promise<Mounted> {
  const dom = new JSDOM('<div id="root"></div>', {
    url: `http://localhost/${hash}`,
  });
  Object.defineProperty(dom.window, "matchMedia", {
    value: () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }),
  });
  for (const [name, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    history: dom.window.history,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  }))
    vi.stubGlobal(name, value);
  if (state !== undefined) dom.window.history.replaceState(state, "");
  const root = createRoot(document.getElementById("root")!);
  const render = async () => {
    await act(async () =>
      root.render(createElement(RiftboundApp, props as never))
    );
  };
  await render();
  return {
    dom,
    render,
    unmount: async () => {
      await act(async () => root.unmount());
      dom.window.close();
    },
  };
}
const catalogLoaded = () =>
  /Editions · Page/.test(document.body.textContent ?? "");
const loaded = async (done: () => boolean) => {
  for (let i = 0; i < 40 && !done(); i++) await settle();
};
const settle = () => act(async () => new Promise((r) => setTimeout(r, 20)));
const popTo = async (m: Mounted, hash: string) => {
  m.dom.window.history.pushState(null, "", hash);
  await act(async () => {
    m.dom.window.dispatchEvent(new m.dom.window.PopStateEvent("popstate"));
  });
};

afterEach(() => vi.unstubAllGlobals());

describe("entry sections follow the adapters supplied", () => {
  it("shows the Catalog for a Collection address when no Collection adapter is supplied", async () => {
    const m = await mount(collectionHash, { reader: fixtureReader() });
    try {
      await settle();
      await loaded(catalogLoaded);
      expect(catalogSearch()).not.toBeNull();
      expect(catalogLoaded()).toBe(true);
      expect(collectionResults()).toBeNull();
    } finally {
      await m.unmount();
    }
  });
  it("falls back to the Catalog when Back or a popstate reaches a Collection address", async () => {
    const m = await mount("#riftbound:view=catalog", {
      reader: fixtureReader(),
    });
    try {
      await settle();
      await popTo(m, collectionHash);
      await settle();
      await loaded(catalogLoaded);
      expect(catalogSearch()).not.toBeNull();
      expect(catalogLoaded()).toBe(true);
      expect(collectionResults()).toBeNull();
    } finally {
      await m.unmount();
    }
  });
  it("keeps the Collection when a Collection adapter is supplied", async () => {
    const props = {
      reader: fixtureReader(),
      collection: collectionFixtureReader("a"),
    };
    const m = await mount(collectionHash, props);
    try {
      await settle();
      expect(collectionResults()).not.toBeNull();
      await popTo(m, "#riftbound:view=catalog");
      await popTo(m, collectionHash);
      await settle();
      expect(collectionResults()).not.toBeNull();
    } finally {
      await m.unmount();
    }
  });
});

describe("the Decks section follows the adapters supplied", () => {
  const catalogOnly = () => ({ reader: fixtureReader() });
  const withoutDecks = () => ({
    reader: fixtureReader(),
    collection: collectionFixtureReader("a"),
  });
  const withDecks = () => ({
    ...withoutDecks(),
    decks: deckFixture("a", "normal", "normal"),
  });
  it.each([
    ["no adapters", catalogOnly],
    ["a Collection but no Decks adapter", withoutDecks],
  ])("shows the Catalog for a Decks address with %s", async (_name, props) => {
    const direct = await mount(decksHash, props());
    try {
      await loaded(catalogLoaded);
      expect(catalogLoaded()).toBe(true);
      expect(decksContent()).toBeNull();
    } finally {
      await direct.unmount();
    }
    const back = await mount("#riftbound:view=catalog", props());
    try {
      await settle();
      await popTo(back, decksHash);
      await loaded(catalogLoaded);
      expect(catalogLoaded()).toBe(true);
      expect(decksContent()).toBeNull();
    } finally {
      await back.unmount();
    }
  });
  it("keeps Decks when both adapters are supplied", async () => {
    const m = await mount(decksHash, withDecks());
    try {
      await settle();
      expect(decksContent()).not.toBeNull();
      await popTo(m, "#riftbound:view=catalog");
      await popTo(m, decksHash);
      await settle();
      expect(decksContent()).not.toBeNull();
    } finally {
      await m.unmount();
    }
  });
});

describe("history entries carry the game", () => {
  const props = () => ({ reader: fixtureReader() });
  it("stamps a direct load, such as a Location opened in a new tab", async () => {
    const m = await mount(collectionHash, {
      reader: fixtureReader(),
      collection: collectionFixtureReader("a"),
    });
    try {
      expect(m.dom.window.history.state).toEqual({ game: "riftbound" });
    } finally {
      await m.unmount();
    }
  });
  it("stamps entries reached by native hash navigation and Back", async () => {
    const m = await mount("#riftbound:view=catalog", props());
    try {
      expect(m.dom.window.history.state).toEqual({ game: "riftbound" });
      m.dom.window.location.hash = "#riftbound:view=catalog&search=a";
      await settle();
      expect(m.dom.window.history.state).toEqual({ game: "riftbound" });
      m.dom.window.history.back();
      await settle();
      expect(m.dom.window.location.hash).toBe("#riftbound:view=catalog");
      expect(m.dom.window.history.state).toEqual({ game: "riftbound" });
    } finally {
      await m.unmount();
    }
  });
  it("keeps same-game detail state and never overwrites another game's state", async () => {
    const detail = await mount("#riftbound:view=catalog", props(), {
      game: "riftbound",
      detail: true,
    });
    try {
      expect(detail.dom.window.history.state).toEqual({
        game: "riftbound",
        detail: true,
      });
    } finally {
      await detail.unmount();
    }
    const other = await mount("#riftbound:view=catalog", props(), {
      game: "pokemon",
    });
    try {
      expect(other.dom.window.history.state).toEqual({ game: "pokemon" });
    } finally {
      await other.unmount();
    }
    const bare = await mount("#riftbound:view=catalog", props(), {
      detail: true,
    });
    try {
      expect(bare.dom.window.history.state).toEqual({
        detail: true,
        game: "riftbound",
      });
    } finally {
      await bare.unmount();
    }
  });
});
