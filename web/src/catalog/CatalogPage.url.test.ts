// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { CatalogPage } from "./CatalogPage";
import { AddQueueAccount } from "./useStoredAddQueue";
const P = "0a1b2c3d-0000-4000-8000-00000000000a";
const E = "0a1b2c3d-0000-4000-8000-00000000000b";
const CARD = { printingId: P, editionId: E };
vi.mock("./CatalogGallery", () => ({
  CatalogGallery: ({
    adding,
    link,
    onLinkOpened,
    routeCard,
    onCardRoute,
    view,
    onViewChange,
  }: {
    view?: { q: string };
    onViewChange?: (view: never) => void;
    adding: boolean;
    link?: { printingId: string } | null;
    onLinkOpened: () => void;
    routeCard?: { printingId: string; editionId: string | null } | null;
    onCardRoute?: (
      card: { printingId: string; editionId: string | null } | null,
      how: "open" | "replace" | "close"
    ) => void;
  }) =>
    h(
      "div",
      null,
      h("output", { "data-printing": link?.printingId }, String(adding)),
      h(
        "output",
        { "data-testid": "route" },
        routeCard ? `${routeCard.printingId}/${routeCard.editionId}` : "none"
      ),
      h("button", { onClick: onLinkOpened }, "Report opened"),
      h(
        "button",
        {
          onClick: () =>
            (onViewChange as ((view: object) => void) | undefined)?.({
              ...view,
              setId: null,
            }),
        },
        "Reset set"
      ),
      h("button", { onClick: () => onCardRoute?.(CARD, "open") }, "Route open"),
      h(
        "button",
        { onClick: () => onCardRoute?.(CARD, "replace") },
        "Route replace"
      ),
      h(
        "button",
        { onClick: () => onCardRoute?.(null, "close") },
        "Route close"
      )
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
              onCloseCard: vi.fn(),
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
      items: [{ editionId: E, printingId: P, quantity: 1 }],
      target: null,
      uncertain: false,
    })
  );
  const address = `/catalog?q=Abra&printing=${P}&edition=${E}`;
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
            onCloseCard: vi.fn(),
            message: "",
          })
        )
      )
    );
    expect(host.querySelector("output")?.getAttribute("data-printing")).toBe(P);
    expect(window.location.search).toBe(
      `?q=Abra&mode=add&card=${P}&edition=${E}`
    );
    expect(navigate).toHaveBeenCalledWith(
      `/catalog?q=Abra&mode=add&card=${P}&edition=${E}`,
      { replace: true, preserveScroll: true, overlay: true }
    );
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
              onCloseCard: vi.fn(),
              message: "",
            })
          )
        )
      );
    await render(`/catalog?q=Abra&mode=add&card=${P}&edition=${E}`);
    await act(async () =>
      [...host.querySelectorAll("button")]
        .find((button) => button.textContent === "Report opened")!
        .click()
    );
    await render("/collection", false);
    await render(`/catalog?q=Abra&mode=add&card=${P}&edition=${E}`);
    expect(
      host.querySelector("output")?.getAttribute("data-printing")
    ).toBeNull();
    expect(navigate).toHaveBeenCalledTimes(1);
    // Another inspector link while Catalog is already active must also be read.
    const second = "0a1b2c3d-0000-4000-8000-00000000000c";
    const secondEdition = "0a1b2c3d-0000-4000-8000-00000000000d";
    await render(
      `/catalog?format=standard&printing=${second}&edition=${secondEdition}`
    );
    expect(host.querySelector("output")?.getAttribute("data-printing")).toBe(
      second
    );
    expect(window.location.search).toBe(
      `?format=standard&mode=add&card=${second}&edition=${secondEdition}`
    );
  } finally {
    await act(async () => root.unmount());
    host.remove();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  }
});

async function mountAt(
  address: string,
  {
    active = true,
    onNavigate = vi.fn(),
    onCloseCard = vi.fn(),
  }: {
    active?: boolean;
    onNavigate?: ReturnType<typeof vi.fn>;
    onCloseCard?: ReturnType<typeof vi.fn>;
  } = {}
) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const render = (nextActive: boolean, nextAddress: string) =>
    act(async () =>
      root.render(
        h(
          AddQueueAccount.Provider,
          { value: "A" },
          h(CatalogPage, {
            active: nextActive,
            address: nextAddress,
            onNavigate: onNavigate as never,
            onCloseCard: onCloseCard as never,
            message: "",
          })
        )
      )
    );
  await render(active, address);
  const click = (name: string) =>
    act(async () =>
      [...host.querySelectorAll("button")]
        .find((button) => button.textContent === name)!
        .click()
    );
  const done = async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  };
  return { host, render, click, done, onNavigate, onCloseCard };
}

test("a malformed card is stripped from the address", async () => {
  const page = await mountAt(`/catalog?q=Abra&card=abc&edition=${E}`);
  try {
    expect(page.onNavigate).toHaveBeenCalledWith("/catalog?q=Abra", {
      replace: true,
      preserveScroll: true,
      overlay: true,
    });
  } finally {
    await page.done();
  }
});

test("an edition without a card is stripped, and a bad edition leaves the card", async () => {
  const lone = await mountAt(`/catalog?edition=${E}`);
  try {
    expect(lone.onNavigate).toHaveBeenCalledWith("/catalog", {
      replace: true,
      preserveScroll: true,
      overlay: true,
    });
  } finally {
    await lone.done();
  }
  const bad = await mountAt(`/catalog?card=${P}&edition=nope`);
  try {
    expect(bad.onNavigate).toHaveBeenCalledWith(`/catalog?card=${P}`, {
      replace: true,
      preserveScroll: true,
      overlay: true,
    });
    expect(bad.host.querySelector("[data-testid=route]")?.textContent).toBe(
      `${P}/null`
    );
  } finally {
    await bad.done();
  }
});

test("a well-formed card address is left alone", async () => {
  const page = await mountAt(`/catalog?q=Abra&card=${P}&edition=${E}`);
  try {
    expect(page.onNavigate).not.toHaveBeenCalled();
    expect(page.host.querySelector("[data-testid=route]")?.textContent).toBe(
      `${P}/${E}`
    );
  } finally {
    await page.done();
  }
});

test("a malformed report link opens nothing and is stripped", async () => {
  const page = await mountAt("/catalog?printing=nope&edition=nope");
  try {
    expect(
      page.host.querySelector("output")?.getAttribute("data-printing")
    ).toBeNull();
    expect(page.onNavigate).toHaveBeenCalledWith("/catalog", {
      replace: true,
      preserveScroll: true,
      overlay: true,
    });
  } finally {
    await page.done();
  }
});

test("mode normalization keeps the card and writes it after the mode", async () => {
  sessionStorage.setItem(
    "prizecheck:add-queue:A:page",
    JSON.stringify({
      items: [{ editionId: E, printingId: P, quantity: 1 }],
      target: null,
      uncertain: false,
    })
  );
  const page = await mountAt(`/catalog?card=${P}&edition=${E}&q=Abra`);
  try {
    expect(page.onNavigate).toHaveBeenCalledWith(
      `/catalog?q=Abra&mode=add&card=${P}&edition=${E}`,
      { replace: true, preserveScroll: true, overlay: true }
    );
  } finally {
    await page.done();
    sessionStorage.clear();
  }
});

test("the gallery's card writes open, replace and close through the page", async () => {
  const page = await mountAt("/catalog?q=Abra&format=standard");
  try {
    await page.click("Route open");
    expect(page.onNavigate).toHaveBeenLastCalledWith(
      `/catalog?q=Abra&format=standard&card=${P}&edition=${E}`,
      { overlay: true, preserveScroll: true }
    );
    await page.render(
      true,
      `/catalog?q=Abra&format=standard&card=${P}&edition=${E}`
    );
    page.onNavigate.mockClear();
    await page.click("Route replace");
    expect(page.onNavigate).not.toHaveBeenCalled();
    await page.click("Route close");
    expect(page.onCloseCard).toHaveBeenCalledWith(
      "/catalog?q=Abra&format=standard"
    );
  } finally {
    await page.done();
  }
});

test("a hidden page writes nothing to the address", async () => {
  const page = await mountAt(`/catalog?card=${P}&edition=${E}`);
  try {
    await page.render(false, "/collection");
    page.onNavigate.mockClear();
    await page.click("Route open");
    await page.click("Route replace");
    await page.click("Route close");
    expect(page.onNavigate).not.toHaveBeenCalled();
    expect(page.onCloseCard).not.toHaveBeenCalled();
    expect(page.host.querySelector("[data-testid=route]")?.textContent).toBe(
      `${P}/${E}`
    );
  } finally {
    await page.done();
  }
});

test("a view change with a card open keeps the card in the address", async () => {
  const page = await mountAt(`/catalog?q=Abra&set=gone&card=${P}&edition=${E}`);
  try {
    await page.click("Reset set");
    expect(page.onNavigate).toHaveBeenLastCalledWith(
      `/catalog?q=Abra&card=${P}&edition=${E}`,
      { replace: true, preserveScroll: true, overlay: true }
    );
  } finally {
    await page.done();
  }
});

test("a printing alone is deleted and opens nothing", async () => {
  const page = await mountAt(`/catalog?q=Abra&printing=${P}`);
  try {
    expect(page.onNavigate).toHaveBeenCalledWith("/catalog?q=Abra", {
      replace: true,
      preserveScroll: true,
      overlay: true,
    });
    expect(
      page.host.querySelector("output")?.getAttribute("data-printing")
    ).toBeNull();
  } finally {
    await page.done();
  }
});

test("a valid printing with a malformed edition opens the card on its default Edition", async () => {
  const page = await mountAt(`/catalog?printing=${P}&edition=nope`);
  try {
    expect(page.onNavigate).toHaveBeenCalledWith(`/catalog?card=${P}`, {
      replace: true,
      preserveScroll: true,
      overlay: true,
    });
    expect(
      page.host.querySelector("output")?.getAttribute("data-printing")
    ).toBeNull();
  } finally {
    await page.done();
  }
});
