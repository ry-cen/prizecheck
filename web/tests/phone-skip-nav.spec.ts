// m12 s6 (Sol m11 B-01): on a phone, a keyboard user reaches the bottom navigation with one more Tab, not by
// Tabbing through the Catalog grid. Desktop has no such link.
import { expect, type Page } from "@playwright/test";
import { test, artUpstream } from "./support/art-upstream";
import { signInWithButton } from "./support/sign-in";

const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";

async function openCatalog(page: Page) {
  (await artUpstream()).reset();
  await page.goto(`${ORIGIN}/collection`);
  await signInWithButton(page);
  await expect(page).toHaveURL(/\/collection$/);
  await page.goto(`${ORIGIN}/catalog`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
}

test.describe("phone", () => {
  test.use({
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
  });

  test("a second skip link goes straight to the bottom navigation", async ({
    page,
  }) => {
    await openCatalog(page);
    const main = page.getByRole("link", { name: "Skip to main content" });
    const nav = page.getByRole("link", { name: "Skip to navigation" });
    // Hidden until focused.
    await expect(nav).not.toBeInViewport();
    await page.keyboard.press("Tab");
    await expect(main).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(nav).toBeFocused();
    await expect(nav).toBeInViewport();
    await page.keyboard.press("Enter");
    const first = page
      .getByRole("navigation", { name: "Main views" })
      .getByRole("link")
      .first();
    await expect(first).toHaveText("Collection");
    await expect(first).toBeFocused();
    await expect(page).toHaveURL(/\/catalog/);
  });
});

test.describe("desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("has no skip link to the navigation", async ({ page }) => {
    await openCatalog(page);
    await expect(
      page.getByRole("link", { name: "Skip to navigation" })
    ).toHaveCount(0);
    await page.keyboard.press("Tab");
    await expect(
      page.getByRole("link", { name: "Skip to main content" })
    ).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(
      page.getByRole("navigation", { name: "Main views" }).getByRole("link")
    ).not.toHaveCount(0);
    await expect(page.locator(":focus")).not.toHaveText("Skip to navigation");
  });
});
