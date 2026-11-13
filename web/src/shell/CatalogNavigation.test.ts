// @vitest-environment jsdom
import React, {
  act,
  createElement as h,
  type ReactNode,
  type FormEvent,
} from "react";
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
vi.mock("./Shell", () => ({
  Shell: ({
    renderPage,
    onNavigate,
    onSignOut,
    page,
  }: {
    renderPage: (page: string, active: boolean) => ReactNode;
    onNavigate: (page: string) => void;
    page: string;
    onSignOut: () => Promise<boolean>;
  }) =>
    h(
      React.Fragment,
      null,
      h("button", { onClick: () => onNavigate("catalog") }, "Catalog tab"),
      h(
        "button",
        { onClick: () => onNavigate("collection") },
        "Collection tab"
      ),
      h("button", { onClick: () => void onSignOut() }, "Sign out"),
      renderPage(page, true)
    ),
}));
vi.mock("../public/PublicLayout", () => ({
  PublicLayout: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../public/SignIn", () => ({
  SignInScreen: ({ emailForms }: { emailForms: ReactNode }) => emailForms,
  EmailCodeForms: ({
    onVerifyCode,
  }: {
    onVerifyCode: (event: FormEvent) => void;
  }) =>
    h(
      "form",
      { onSubmit: onVerifyCode },
      h("button", { type: "submit" }, "Sign in B")
    ),
}));
vi.mock("./lazyPages", () => {
  const Empty = () => null;
  return {
    CatalogPage: ({
      address,
      onNavigate,
    }: {
      address: string;
      onNavigate: (to: string) => void;
    }) =>
      h(
        "main",
        null,
        h("output", null, address),
        h(
          "button",
          {
            onClick: () =>
              onNavigate("/catalog?q=Ivysaur&format=standard&mode=add"),
          },
          "Set catalog view"
        )
      ),
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

it.each([false, true])(
  "Catalog tab isolates a signed-out account (signOut=%s)",
  async (signOut) => {
    let userId = "A";
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ signedIn: true, userId }),
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
      const click = async (name: string) => {
        await act(async () =>
          [...host.querySelectorAll("button")]
            .find((button) => button.textContent === name)!
            .click()
        );
      };
      await click("Catalog tab");
      await click("Set catalog view");
      await click("Collection tab");
      await click("Catalog tab");
      expect(host.querySelector("output")?.textContent).toBe(
        "/catalog?q=Ivysaur&format=standard&mode=add"
      );
      if (signOut) {
        await click("Sign out");
        userId = "B";
        await click("Sign in B");
        await click("Catalog tab");
        expect(host.querySelector("output")?.textContent).toBe("/catalog");
      }
    } finally {
      await act(async () => root.unmount());
      host.remove();
      vi.unstubAllGlobals();
    }
  }
);
