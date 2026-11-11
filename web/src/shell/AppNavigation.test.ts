// @vitest-environment jsdom
import React, { act, createElement as h, type ReactNode } from "react";
import { expect, it, vi } from "vitest";

const bootstrap = vi.hoisted(() => ({
  render: vi.fn<(node: ReactNode) => void>(),
}));
vi.mock("react-dom/client", () => ({
  createRoot: () => ({ render: bootstrap.render }),
}));
vi.mock("../generated", async (original) => ({
  ...(await original<typeof import("../generated")>()),
  getOwnerCatalogStatus: async () => null,
}));
vi.mock("../ui/ScrollArea", async (original) => ({
  ...(await original<typeof import("../ui/ScrollArea")>()),
  DocumentScrollbar: () => null,
}));
vi.mock("./Shell", async (original) => ({
  ...(await original<typeof import("./Shell")>()),
  Shell: ({
    renderPage,
  }: {
    renderPage: (page: "collection", active: boolean) => ReactNode;
  }) => h(React.Fragment, null, renderPage("collection", true)),
}));
vi.mock("./lazyPages", () => {
  const Empty = () => null;
  return {
    CatalogPage: Empty,
    CollectionImportPage: Empty,
    DeckBuilderPage: Empty,
    DecksPage: Empty,
    FriendTradeListPage: Empty,
    ImportPage: Empty,
    LoansPage: Empty,
    MissingCardsPage: Empty,
    OwnerControlsPage: Empty,
    ReplaceListPage: Empty,
    TradesPage: Empty,
    preloadInitialPage: () => {},
    Workspace: ({
      address,
      onNavigate,
    }: {
      address: string;
      onNavigate: (to: string) => void;
    }) => {
      const location = new URL(
        address,
        window.location.origin
      ).searchParams.get("location");
      return h(
        "main",
        null,
        h("h1", null, location === "binder" ? "My binder" : "All owned"),
        h("output", null, address),
        h(
          "button",
          { onClick: () => onNavigate("/collection?location=binder&q=Abra") },
          "Open binder"
        )
      );
    },
  };
});

import "../main";

it("passes full addresses through App/Shell on Location selection and reload", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      json: async () => ({ signedIn: true, userId: "collector" }),
    }))
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }))
  );
  window.history.replaceState(null, "", "/collection");
  const host = document.createElement("div");
  host.id = "root";
  document.body.append(host);
  const { createRoot } =
    await vi.importActual<typeof import("react-dom/client")>(
      "react-dom/client"
    );
  let root = createRoot(host);
  try {
    const app = bootstrap.render.mock.calls[0][0];
    await act(async () => root.render(app));
    expect(host.querySelector("h1")?.textContent).toBe("All owned");
    await act(async () => host.querySelector("button")!.click());
    expect(host.querySelector("h1")?.textContent).toBe("My binder");
    expect(host.querySelector("output")?.textContent).toBe(
      "/collection?location=binder&q=Abra"
    );
    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => root.render(app));
    expect(host.querySelector("h1")?.textContent).toBe("My binder");
    expect(host.querySelector("output")?.textContent).toBe(
      "/collection?location=binder&q=Abra"
    );
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
