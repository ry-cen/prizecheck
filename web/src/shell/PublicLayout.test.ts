// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { PublicLayout } from "../public/PublicLayout";
it("puts the skip link first and focuses the page heading on activation", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    }
  );
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        h(PublicLayout, {
          onNavigate: () => {},
          children: h("main", null, h("h1", null, "Published Deck")),
        })
      )
    );
    const link = host.querySelector("a")!;
    expect(link.textContent).toBe("Skip to main content");
    await act(async () => link.click());
    expect(document.activeElement).toBe(host.querySelector("h1"));
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
