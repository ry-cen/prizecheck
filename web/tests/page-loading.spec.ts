// Route-level code splitting: a page whose code fails to load shows a reload prompt in its own area while the
// header, the tabs and the other pages keep working, and only a reload recovers it. Covers a signed-in page
// (Trades) and a public page (Discover) under the public header. On a phone, Collection's stand-ins keep the shell's
// phone header.
import { test, expect } from "@playwright/test";
import { expectPageChecks } from "./support/page-check";
import { signInAsOwner } from "./support/sign-in";

const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";

test("a page whose code fails to load offers a reload, and the rest of the app keeps working", async ({
  page,
}) => {
  await signInAsOwner(page, "/collection");
  const heading = page.getByRole("heading", { level: 1 });
  await expect(heading).toHaveText("All owned");

  const isTradesCode = (url: URL) =>
    url.pathname === "/src/trades/TradesPage.tsx";
  await page.route(isTradesCode, (route) => route.abort());

  const tabs = page.getByRole("navigation", { name: "Main views" });
  // The tab may be named "Trades, N need you", since the owner is shared across specs.
  await tabs.getByRole("button", { name: "Trades" }).click();
  await expect(page).toHaveURL(/\/trades$/);
  await expect(heading).toHaveText("This page didn't load");
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "Reload to try again."
  );
  await expect(page.getByRole("button", { name: "Reload" })).toBeVisible();
  await expectPageChecks(page, "page that didn't load");

  await tabs.getByRole("button", { name: "Decks" }).click();
  await expect(heading).toHaveText("Decks");
  await expect(tabs.getByRole("button", { name: "Decks" })).toHaveAttribute(
    "aria-current",
    "page"
  );

  // The failed import is cached, so only a reload recovers the page.
  await page.unroute(isTradesCode);
  await tabs.getByRole("button", { name: "Trades" }).click();
  await expect(heading).toHaveText("This page didn't load");

  await page.getByRole("button", { name: "Reload" }).click();
  await expect(page).toHaveURL(/\/trades$/);
  await expect(heading).toHaveText("Trades");
});

test("a public page whose code fails to load offers a reload under the public header", async ({
  page,
}) => {
  const isDiscoverCode = (url: URL) =>
    url.pathname === "/src/discover/DiscoverPage.tsx";
  await page.route(isDiscoverCode, (route) => route.abort());

  await page.goto(`${ORIGIN}/discover`);
  const heading = page.getByRole("heading", { level: 1 });
  await expect(heading).toHaveText("This page didn't load");
  await expect(
    page
      .getByRole("navigation", { name: "Public pages" })
      .getByRole("link", { name: "Discover decks" })
  ).toBeVisible();

  await page.unroute(isDiscoverCode);
  await page.getByRole("button", { name: "Reload" }).click();
  await expect(heading).toHaveText("Discover decks");
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

  const isWorkspaceCode = (url: URL) =>
    url.pathname === "/src/workspace/Workspace.tsx";

  test("Collection whose code fails to load keeps the shell's phone header, and Reload brings back Collection's own", async ({
    page,
  }) => {
    // Before sign-in: /collection preloads Workspace at boot.
    await page.route(isWorkspaceCode, (route) => route.abort());
    await signInAsOwner(page, "/collection");
    const heading = page.getByRole("heading", { level: 1 });
    const banner = page.getByRole("banner");
    const tabs = page.getByRole("navigation", { name: "Main views" });

    await expect(heading).toHaveText("This page didn't load");
    await expect(banner).toHaveCount(1);
    await expect(banner).toContainText("PrizeCheck");
    await expect(
      banner.getByRole("button", { name: "Account", exact: true })
    ).toBeVisible();
    await expect(banner.getByRole("button", { name: /^Inbox/ })).toBeVisible();
    await expect(
      banner.getByRole("button", { name: /^Friends/ })
    ).toBeVisible();
    await expect(
      tabs.getByRole("button", { name: "Collection", exact: true })
    ).toHaveAttribute("aria-current", "page");
    await expectPageChecks(page, "Collection that didn't load, on a phone");

    await page.unroute(isWorkspaceCode);
    await page.getByRole("button", { name: "Reload" }).tap();
    await expect(page).toHaveURL(/\/collection$/);
    await expect(heading).toHaveText("All owned");
    await expect(banner).toHaveCount(1);
    await expect(
      banner.getByRole("button", { name: "Open locations" })
    ).toBeVisible();
    await expect(banner).not.toContainText("PrizeCheck");
  });

  test("while Collection's code is slow to load, the shell's phone header shows with the placeholder", async ({
    page,
  }) => {
    await signInAsOwner(page, "/decks");
    const heading = page.getByRole("heading", { level: 1 });
    const banner = page.getByRole("banner");
    const tabs = page.getByRole("navigation", { name: "Main views" });
    await expect(heading).toHaveText("Decks");

    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route(isWorkspaceCode, async (route) => {
      await held;
      await route.continue();
    });
    try {
      const collectionTab = tabs.getByRole("button", {
        name: "Collection",
        exact: true,
      });
      await collectionTab.tap();
      await expect(page).toHaveURL(/\/collection$/);
      await expect(collectionTab).toHaveAttribute("aria-current", "page");
      await expect(banner).toHaveCount(1);
      await expect(banner).toContainText("PrizeCheck");
    } finally {
      release();
    }

    await expect(heading).toHaveText("All owned");
    await expect(
      banner.getByRole("button", { name: "Open locations" })
    ).toBeVisible();
    await expect(banner).toHaveCount(1);
    await expect(banner).not.toContainText("PrizeCheck");
  });
});
