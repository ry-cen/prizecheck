import { expect } from "@playwright/test";
import { test } from "./support/art-upstream";
const origin = process.env.TEST_ORIGIN || "http://127.0.0.1:5173";
const entry = `${origin}/src/games/riftbound/local/index.html`;
const hash = "#riftbound:section=collection";
for (const width of [1280, 375]) {
  test(`fixture Collection navigation and keyboard at ${width}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 800 });
    const calls: string[] = [];
    page.on("request", (r) => {
      if (/^\/(api|auth)(\/|$)/.test(new URL(r.url()).pathname))
        calls.push(r.url());
    });
    await page.addInitScript(() =>
      localStorage.setItem(
        "prizecheck:workspace:preferences:v1:1",
        "collection-sentinel"
      )
    );
    await page.goto(entry);
    const catalogSearch = page.getByRole("searchbox", {
      name: "Search cards",
      exact: true,
    });
    await catalogSearch.fill("001");
    const navigation = page.getByRole("navigation", {
      name: width === 375 ? "Mobile navigation" : "Main navigation",
    });
    await navigation
      .getByRole("button", { name: "Collection", exact: true })
      .click();
    const results = page.getByRole("region", { name: "Collection results" });
    await expect(results.getByRole("listitem")).toHaveCount(24);
    await navigation
      .getByRole("button", { name: "Catalog", exact: true })
      .click();
    await expect(catalogSearch).toHaveValue("001");
    await navigation
      .getByRole("button", { name: "Collection", exact: true })
      .click();
    await expect(results.getByRole("listitem")).toHaveCount(24);
    const shot = async (name: string) => {
      const path = info.outputPath(`${name}.png`);
      await page.screenshot({ path });
      await info.attach(name, { path, contentType: "image/png" });
    };
    if (width === 1280)
      await expect(
        page.getByRole("button", { name: "Locations", exact: true })
      ).toHaveCount(0);
    if (width === 375) {
      await shot("phone-collection");
      await page
        .getByRole("button", { name: "Locations", exact: true })
        .click();
      await shot("phone-locations-drawer");
    }
    const tree =
      width === 375
        ? page.getByRole("dialog", { name: "Locations" })
        : page.getByRole("complementary").filter({
            has: page.getByRole("heading", {
              name: "Locations",
              exact: true,
            }),
          });
    await tree.getByRole("button", { name: "Binders", exact: true }).click();
    await tree.getByRole("link", { name: "Blue binder", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Blue binder", exact: true })
    ).toBeVisible();
    if (width === 375)
      await expect(
        page.getByRole("button", { name: "Locations", exact: true })
      ).toBeFocused();
    if (width === 375) {
      const address = page.url();
      await page
        .getByRole("button", { name: "Locations", exact: true })
        .click();
      await tree
        .getByRole("link", { name: "Blue binder", exact: true })
        .click();
      await expect(page).toHaveURL(address);
    }
    await page.goBack();
    await expect(
      page.getByRole("heading", { name: "All owned", exact: true })
    ).toBeFocused();
    await page.goForward();
    await expect(
      page.getByRole("heading", { name: "Blue binder", exact: true })
    ).toBeFocused();
    const search = page.getByRole("searchbox", { name: "Search your cards" });
    await search.fill("001");
    await expect(results.getByRole("listitem")).toHaveCount(2);
    const tile = results.getByRole("button").first();
    await tile.focus();
    await page.keyboard.press("Enter");
    await expect(results.locator('li button[aria-pressed="true"]')).toHaveCount(
      1
    );
    if (width === 1280) {
      await tile.click();
      await expect(
        results.locator('li button[aria-pressed="true"]')
      ).toHaveCount(0);
      await tile.click();
      await expect(
        results.locator('li button[aria-pressed="true"]')
      ).toHaveCount(1);
    }
    const details =
      width === 375
        ? page.getByRole("dialog", { name: "Ember Scout" })
        : page.getByRole("complementary", { name: "Card details" });
    await expect(
      details.getByRole("img", {
        name: "Artwork unavailable for Ember Scout",
      })
    ).toBeVisible();
    await expect(
      details.getByText("Unsorted · 3", { exact: true })
    ).toBeVisible();
    await expect(
      details.getByText("Binders / Blue binder · 2", { exact: true })
    ).toBeVisible();
    if (width === 375) {
      await page.keyboard.press("Escape");
      await expect(tile).toBeFocused();
    } else await shot("desktop-location-inspector");
    await search.fill("");
    await expect(results.getByRole("listitem")).toHaveCount(24);
    const next = page.getByRole("button", { name: "Next page", exact: true });
    await next.focus();
    if (width === 375) {
      const box = await next.boundingBox();
      const bar = await navigation.boundingBox();
      expect(box!.y + box!.height).toBeLessThanOrEqual(bar!.y);
    }
    await page.keyboard.press("Enter");
    await expect(results.getByRole("listitem")).toHaveCount(6);
    await page.goBack();
    await expect(results.getByRole("listitem")).toHaveCount(24);
    await page.goForward();
    await expect(results.getByRole("listitem")).toHaveCount(6);
    await search.fill("nothing matches");
    await expect(
      page.getByText("No cards match your search.", { exact: true })
    ).toBeVisible();
    await page.getByRole("button", { name: "Clear search" }).click();
    await expect(results.getByRole("listitem")).toHaveCount(24);
    if (width === 1280) {
      await tree.getByRole("link", { name: "All owned", exact: true }).click();
      await expect(results.getByRole("listitem")).toHaveCount(24);
      await results.getByRole("button").first().click();
      await expect(
        details.getByText("Unsorted · 3", { exact: true })
      ).toBeVisible();
      await expect(
        details.getByText("Binders / Blue binder · 2", { exact: true })
      ).toBeInViewport();
      const columns = await results
        .locator("ul")
        .evaluate(
          (el) => getComputedStyle(el).gridTemplateColumns.split(" ").length
        );
      expect(columns).toBe(5);
      await expect(search).toHaveAttribute("placeholder", "Search your cards…");
      expect((await search.boundingBox())!.width).toBeLessThanOrEqual(420);
      await expect(
        details.getByText("Variant Standard", { exact: true })
      ).toBeVisible();
      await shot("desktop-all-owned-inspector");
      const lower = results.locator("li button").last();
      await lower.scrollIntoViewIfNeeded();
      await lower.click();
      const inspectorHeading = details.getByRole("heading");
      await expect(inspectorHeading).toBeInViewport();
      const bounds = await inspectorHeading.boundingBox();
      expect(bounds!.y).toBeGreaterThanOrEqual(64);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(800);
      await shot("desktop-sticky-inspector");
    }
    expect(
      await page.evaluate(() =>
        localStorage.getItem("prizecheck:workspace:preferences:v1:1")
      )
    ).toBe("collection-sentinel");
    expect(calls).toEqual([]);
    // Catalog's last paging control must also clear the same fixed tab bar.
    if (width === 375) {
      await navigation
        .getByRole("button", { name: "Catalog", exact: true })
        .click();
      await catalogSearch.fill("");
      const catalogNext = page.getByRole("button", {
        name: "Next page",
        exact: true,
      });
      await catalogNext.focus();
      const box = await catalogNext.boundingBox();
      const bar = await navigation.boundingBox();
      expect(box!.y + box!.height).toBeLessThanOrEqual(bar!.y);
    }
  });
  test(`fixture Collection states and rapid choices at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 800 });
    await page.goto(`${entry}?collection=empty${hash}`);
    await expect(
      page.getByText("No cards in your Collection yet.", { exact: true })
    ).toBeVisible();
    await page.getByRole("button", { name: "Browse Catalog" }).click();
    await expect(
      page.getByRole("heading", { name: "Catalog", exact: true })
    ).toBeVisible();
    await page.goto(`${entry}?collection=failure${hash}`);
    await expect(
      page.getByText("Cards couldn't be loaded.", { exact: true })
    ).toBeVisible();
    if (width === 375)
      await page
        .getByRole("button", { name: "Locations", exact: true })
        .click();
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: "Locations couldn't be loaded." })
    ).toBeVisible();
    const treeFailure = page
      .getByRole("alert")
      .filter({ hasText: "Locations couldn't" });
    await treeFailure.getByRole("button", { name: "Retry" }).click();
    if (width === 375)
      await page
        .getByRole("dialog", { name: "Locations" })
        .getByRole("button", { name: "Close", exact: true })
        .click();
    await page
      .getByRole("alert")
      .filter({ hasText: "Cards couldn't" })
      .getByRole("button", { name: "Retry" })
      .click();
    await expect(
      page
        .getByRole("region", { name: "Collection results" })
        .getByRole("listitem")
    ).toHaveCount(24);
    await page.goto(`${entry}?collection=slow${hash}`);
    await expect(
      page.getByText("Loading Collection…", { exact: true })
    ).toBeVisible();
    if (width === 375)
      await page
        .getByRole("button", { name: "Locations", exact: true })
        .click();
    const nav =
      width === 375
        ? page.getByRole("dialog", { name: "Locations" })
        : page.getByRole("navigation", { name: "Locations", exact: true });
    await nav.getByRole("link", { name: "Unsorted", exact: true }).click();
    if (width === 375)
      await page
        .getByRole("button", { name: "Locations", exact: true })
        .click();
    await nav.getByRole("link", { name: "Empty binder", exact: true }).click();
    await expect(
      page.getByText("No cards in this Location.", { exact: true })
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Empty binder", exact: true })
    ).toBeVisible();
    await page.goto(`${entry}?owner=b${hash}`);
    await expect(
      page
        .getByRole("region", { name: "Collection results" })
        .getByRole("listitem")
    ).toHaveCount(2);
    await expect(
      page.getByRole("button", { name: /Beacon Keeper/ }).first()
    ).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: /Ember Scout|Forgotten Sentinel|Shore Guardian/,
      })
    ).toHaveCount(0);
  });
}

for (const [owner, pageNumber, expectedPage, tiles] of [
  ["b", 2, 1, 2],
  ["a", 9, 2, 12],
] as const) {
  test(`clamps owner ${owner} Collection page ${pageNumber}`, async ({
    page,
  }) => {
    await page.goto(
      `${entry}?owner=${owner}${hash}&collectionPage=${pageNumber}`
    );
    await expect(
      page
        .getByRole("region", { name: "Collection results" })
        .getByRole("listitem")
    ).toHaveCount(tiles);
    await expect(page).toHaveURL(
      (url) =>
        new URLSearchParams(url.hash.slice(11)).get("collectionPage") ===
        String(expectedPage)
    );
    await expect(
      page.getByText("No cards in this Location.", { exact: true })
    ).toHaveCount(0);
    await expect(
      page.getByText(`Page ${expectedPage} of ${expectedPage}`, { exact: true })
    ).toBeVisible();
  });
}
