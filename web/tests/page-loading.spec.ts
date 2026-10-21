// Route-level code splitting: a page whose code fails to load shows a reload prompt in its own area while the
// header, the tabs and the other pages keep working, and only a reload recovers it. Covers a signed-in page
// (Trades) and a public page (Discover) under the public header.
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
