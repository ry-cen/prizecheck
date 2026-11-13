// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { CatalogPage } from "./CatalogPage";
import { AddQueueAccount } from "./useStoredAddQueue";
vi.mock("./CatalogGallery", () => ({
  CatalogGallery: ({
    adding,
    link,
    onLinkOpened,
  }: {
    adding: boolean;
    link?: { printingId: string } | null;
    onLinkOpened: () => void;
  }) =>
    h(
      "div",
      null,
      h("output", { "data-printing": link?.printingId }, String(adding)),
      h("button", { onClick: onLinkOpened }, "Report opened")
    ),
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

test("kept Add queue does not consume a metadata report before it opens", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  sessionStorage.setItem(
    "prizecheck:add-queue:A:page",
    JSON.stringify({
      items: [{ editionId: "edition", printingId: "printing", quantity: 1 }],
      target: null,
      uncertain: false,
    })
  );
  const address = "/catalog?q=Abra&printing=printing&edition=edition";
  window.history.replaceState(null, "", address);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const navigate = vi.fn((next: string) =>
    window.history.replaceState(null, "", next)
  );
  try {
    await act(async () =>
      root.render(
        h(
          AddQueueAccount.Provider,
          { value: "A" },
          h(CatalogPage, {
            active: true,
            address,
            onNavigate: navigate,
            message: "",
          })
        )
      )
    );
    expect(host.querySelector("output")?.getAttribute("data-printing")).toBe(
      "printing"
    );
    expect(window.location.search).toBe("?q=Abra&mode=add");
    expect(navigate).toHaveBeenCalledWith("/catalog?q=Abra&mode=add", {
      replace: true,
      preserveScroll: true,
    });
    const render = async (address: string, active = true) =>
      act(async () =>
        root.render(
          h(
            AddQueueAccount.Provider,
            { value: "A" },
            h(CatalogPage, {
              active,
              address,
              onNavigate: navigate,
              message: "",
            })
          )
        )
      );
    await render("/catalog?q=Abra&mode=add");
    await act(async () =>
      [...host.querySelectorAll("button")]
        .find((button) => button.textContent === "Report opened")!
        .click()
    );
    await render("/collection", false);
    await render("/catalog?q=Abra&mode=add");
    expect(
      host.querySelector("output")?.getAttribute("data-printing")
    ).toBeNull();
    expect(navigate).toHaveBeenCalledTimes(1);
    // Another inspector link while Catalog is already active must also be read.
    await render(
      "/catalog?format=standard&printing=second&edition=second-edition"
    );
    expect(host.querySelector("output")?.getAttribute("data-printing")).toBe(
      "second"
    );
    expect(window.location.search).toBe("?format=standard&mode=add");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  }
});
