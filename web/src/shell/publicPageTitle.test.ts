// @vitest-environment jsdom
import { act, createElement as h, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { PublicLayout } from "../public/PublicLayout";

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
