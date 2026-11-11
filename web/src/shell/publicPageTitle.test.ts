// @vitest-environment jsdom
import { act, createElement as h, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { PublicLayout } from "../public/PublicLayout";
import { usePageTitle } from "./usePageTitle";

it("updates the signed-out title when an async page heading arrives", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    }
  );
  let loaded!: (name: string) => void;
  function Page() {
    const [name, setName] = useState("");
    loaded = setName;
    return h(PublicLayout, {
      current: "discover",
      onNavigate: () => {},
      children: name ? h("main", null, h("h1", null, name)) : null,
    });
  }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(h(Page)));
    expect(document.title).toBe("Discover · PrizeCheck");
    await act(async () => loaded("My Published Deck"));
    expect(document.title).toBe("My Published Deck · PrizeCheck");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it("ignores unrelated page mutations and follows heading edits and replacement", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  let frame!: HTMLDivElement;
  function Page() {
    usePageTitle(() => frame, "Decks", "decks");
    return h(
      "div",
      {
        ref: (node: HTMLDivElement) => {
          frame = node;
        },
      },
      h("h1", null, "My Deck"),
      h("p", null, "Loading cards")
    );
  }
  const root = createRoot(host);
  try {
    await act(async () => root.render(h(Page)));
    const scan = vi.spyOn(frame, "querySelector");
    const title = vi.spyOn(document, "title", "set");
    await act(async () => {
      frame.querySelector("p")!.textContent = "200 cards";
    });
    expect(title).not.toHaveBeenCalled();
    expect(scan).toHaveBeenCalledTimes(1); // Only the test's lookup, never a title rescan.
    await act(async () => {
      frame.querySelector("h1")!.textContent = "Renamed Deck";
    });
    expect(document.title).toBe("Renamed Deck · PrizeCheck");
    await act(async () => {
      const next = document.createElement("h1");
      next.textContent = "Published Deck";
      frame.querySelector("h1")!.replaceWith(next);
    });
    expect(document.title).toBe("Published Deck · PrizeCheck");
    await act(async () => {
      frame.querySelector("h1")!.remove();
    });
    expect(document.title).toBe("Decks · PrizeCheck");
  } finally {
    await act(async () => root.unmount());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
