// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { CatalogPage } from "./CatalogPage";
import { AddQueueAccount } from "./useStoredAddQueue";
vi.mock("./CatalogGallery", () => ({
  CatalogGallery: ({ adding }: { adding: boolean }) =>
    h("output", null, String(adding)),
}));
vi.mock("../ui/Dialog", () => ({ Dialog: () => null }));
vi.mock("../MetadataReport", () => ({ MyMetadataReports: () => null }));
test.each([false, true])(
  "explicit mode wins after hidden account transition (return to A: %s)",
  async (returnToA) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }));
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const navigate = vi.fn();
    async function render(account: string, active: boolean, address: string) {
      await act(async () =>
        root.render(
          h(
            AddQueueAccount.Provider,
            { value: account },
            h(CatalogPage, {
              active,
              address,
              onNavigate: navigate,
              message: "",
            })
          )
        )
      );
    }
    try {
      await render(
        "A",
        true,
        returnToA ? "/catalog?mode=add" : "/catalog?mode=browse"
      );
      await render("A", false, "/collection");
      await render("B", false, "/collection");
      if (returnToA) {
        await render("A", false, "/collection");
        expect(host.querySelector("output")?.textContent).toBe("false");
      }
      await render(returnToA ? "A" : "B", true, "/catalog?mode=add");
      expect(host.querySelector("output")?.textContent).toBe("true");
      expect(navigate).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      host.remove();
      vi.unstubAllGlobals();
    }
  }
);
