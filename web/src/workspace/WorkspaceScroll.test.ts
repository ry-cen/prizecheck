// @vitest-environment jsdom
import { act, createElement as h, useLayoutEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useRoute, type Route } from "../shell/useRoute";
import { restorePageScroll } from "../shell/restorePageScroll";
import { ToastProvider, useToast } from "../ui/Toast";
import { Workspace } from "./Workspace";

vi.mock("../location_generated", async (original) => ({
  ...(await original<typeof import("../location_generated")>()),
  getLocationTree: async () => ({
    locations: ["A", "B"].map((id) => ({
      id,
      name: id,
      kind: "storage",
      parent_id: null,
      version: 1,
      depth: 0,
      copy_count: "0",
      hidden: false,
      hidden_by: null,
      own_for_trade: false,
      for_trade: false,
      for_trade_by: null,
    })),
    owner_revision: 1,
    lent_copies: "0",
    borrowed_copies: "0",
  }),
}));
vi.mock("./useGalleryData", async () => {
  const { EMPTY_GALLERY } = await import("./galleryModel");
  const ready = {
    ...EMPTY_GALLERY,
    status: "ready",
    ownerRevision: 1,
    reload: () => {},
    refresh: () => false,
    refreshing: false,
  };
  return { useGalleryData: () => ready };
});
vi.mock("./useOwnedSets", () => ({ useOwnedSets: () => [] }));
const fixtureToast = vi.hoisted(() => ({
  id: 1,
  message: "Removed 1 copy.",
  entry: null,
  unavailable: false,
}));
vi.mock("./useInventoryActions", () => ({
  useInventoryActions: () => ({
    busy: false,
    dialog: null,
    pending: null,
    toast: fixtureToast,
    actionsButton: { current: null },
    hostNotice: { current: null },
    superseded: () => {},
  }),
}));
vi.mock("./useStaleCollection", () => ({
  useStaleCollection: () => ({ stale: false, note: null }),
}));
vi.mock("./tileDrag", () => ({
  useTileDrag: () => ({ badge: null, drop: null }),
  DragBadge: () => null,
}));
vi.mock("./Gallery", () => ({ Gallery: () => null }));
vi.mock("./Inspector", () => ({
  Inspector: () => null,
  DetailsSheet: () => null,
}));
vi.mock("./CorrectionsNotice", () => ({ CorrectionsNotice: () => null }));
vi.mock("../shell/HeaderActions", () => ({ PhoneHeaderActions: () => null }));
vi.mock("../loans/BorrowedDialog", () => ({ BorrowedDialog: () => null }));
vi.mock("../loans/LentOutDialog", () => ({ LentOutDialog: () => null }));
vi.mock("../loans/LendOfferDialog", () => ({ LendOfferDialog: () => null }));

it.each(["replacement", "dismissal"])(
  "real Collection scroll and skip link follow toast %s",
  async (scenario) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }));
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    vi.stubGlobal("scrollY", 0);
    const scroll = vi.spyOn(window, "scrollTo").mockImplementation((_x, y) => {
      vi.stubGlobal("scrollY", y);
    });
    const stored = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
      removeItem: (key: string) => stored.delete(key),
      clear: () => stored.clear(),
    });
    window.history.replaceState(null, "", "/collection?location=A");
    let route!: Route;
    let toastApi!: ReturnType<typeof useToast>;
    function Page() {
      route = useRoute();
      toastApi = useToast();
      const content = useRef<HTMLDivElement>(null);
      // The real Shell's layout phase, around the real Workspace and its passive effects.
      useLayoutEffect(
        () => restorePageScroll(content.current, route.scrollFor(route.path)),
        [route.entry]
      );
      return h(
        "div",
        { ref: content },
        h(Workspace, {
          userId: "scroll-collector",
          address: route.address,
          active: true,
          onNavigate: route.navigate,
          onCloseCard: route.closeOverlay,
          onOpenDeck: () => {},
          onImport: () => {},
          onOpenLoan: () => {},
        })
      );
    }
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    async function traverse(direction: "back" | "forward") {
      await act(async () => {
        const popped = new Promise<void>((resolve) =>
          window.addEventListener("popstate", () => resolve(), { once: true })
        );
        window.history[direction]();
        await popped;
      });
    }
    try {
      await act(async () => root.render(h(ToastProvider, null, h(Page))));
      expect(host.querySelector("h1")?.textContent).toBe("A");
      expect(host.querySelector('a[href="#ws-dock"]')).toBeNull();
      expect(host.querySelector('a[href="#app-toasts"]')).not.toBeNull();
      expect(document.getElementById("app-toasts")).not.toBeNull();
      const link = host.querySelector<HTMLAnchorElement>(
        'a[href="#app-toasts"]'
      )!;
      await act(async () => link.click());
      expect(document.activeElement?.getAttribute("aria-label")).toBe(
        "Dismiss"
      );
      await act(async () => {
        toastApi.show({ message: "Couldn't sign out. Try again." });
      });
      if (scenario === "dismissal") {
        await act(async () =>
          document
            .querySelector<HTMLButtonElement>(
              '#app-toasts button[aria-label="Dismiss"]'
            )!
            .click()
        );
      }
      expect(host.querySelector('a[href="#app-toasts"]')).toBeNull();
      window.scrollTo(0, 500);
      await act(async () => route.navigate("/collection?location=B"));
      expect(window.scrollY).toBe(0); // Fresh Location entry starts at the top.
      window.scrollTo(0, 300);
      scroll.mockClear();
      await traverse("back");
      expect(host.querySelector("h1")?.textContent).toBe("A");
      expect(window.scrollY, JSON.stringify(scroll.mock.calls)).toBe(500);
      expect(scroll.mock.calls.map((call) => call[1])).toEqual([500]);
      await traverse("forward");
      expect(host.querySelector("h1")?.textContent).toBe("B");
      expect(window.scrollY).toBe(300);
    } finally {
      await act(async () => root.unmount());
      host.remove();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  }
);
