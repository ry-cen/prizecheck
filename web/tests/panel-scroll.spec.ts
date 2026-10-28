// Issue #365: a panel taller than the screen scrolls its body inside the frame, with the header kept in view. The Catalog
// set picker (the shared Dialog's centred panel, a bottom sheet on a phone) holds a long list: its last set must be
// reachable by scrolling at 1280×800 and at 375×812.
import { test, expect, type Page } from "@playwright/test";
import { Pool } from "pg";
import { signInAsOwner } from "./support/sign-in";
import { startAsNewOwner } from "./support/owner";

const SETS = Array.from({ length: 120 }, (_, index) => {
  const number = String(index + 1).padStart(3, "0");
  return {
    set_id: `scroll-${number}`,
    set_name: `Scroll Set ${number}`,
    set_code: `S${number}`,
    printings: index + 1,
    series_id: "scroll",
    series_name: "Scroll Era",
    release_date: "2024-01-01",
  };
});

/** Signs in as a new owner at /catalog with a 120-set list standing in for the API's, and opens the set picker. */
async function openSetPicker(page: Page) {
  await page.route("**/api/catalog/sets", (route) =>
    route.fulfill({
      json: { available: true, catalog_revision: 1, sets: SETS },
    })
  );
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await startAsNewOwner(pool);
    await pool.query("DELETE FROM auth_send_event");
  } finally {
    await pool.end();
  }
  await signInAsOwner(page, "/catalog");
  await page.getByRole("button", { name: /Any set/ }).click();
  const picker = page.getByRole("dialog", { name: "Choose a set" });
  await expect(picker).toBeVisible();
  await expect(picker.getByRole("list", { name: "Sets" })).toBeVisible();
  // The sets sit in one era folder, closed to start with; open it so the whole list is on show.
  const era = picker.getByRole("button", { name: /^Scroll Era/ });
  await expect(era).toHaveAttribute("aria-expanded", "false");
  await era.click();
  await expect(era).toHaveAttribute("aria-expanded", "true");
  return picker;
}

async function expectBodyScrolls(page: Page) {
  const picker = await openSetPicker(page);
  const close = picker.getByRole("button", { name: "Close set picker" });
  const last = picker.getByRole("button", { name: /Scroll Set 120/ });
  const viewport = page.viewportSize()!;

  // The panel stays inside the screen, so its overflow is the body's to scroll.
  const frame = (await picker.boundingBox())!;
  expect(frame.y).toBeGreaterThanOrEqual(0);
  expect(frame.y + frame.height).toBeLessThanOrEqual(viewport.height);
  const body = picker.locator("div.overflow-auto");
  await expect
    .poll(() =>
      body.evaluate((element) => element.scrollHeight > element.clientHeight)
    )
    .toBe(true);

  // The last set starts below the body's edge and a wheel over the list brings it in.
  await body.hover();
  await page.mouse.wheel(0, 100_000);
  await expect
    .poll(() =>
      body.evaluate(
        (element) =>
          element.scrollTop + element.clientHeight >= element.scrollHeight - 1
      )
    )
    .toBe(true);
  await expect(last).toBeInViewport({ ratio: 1 });
  await expect(close).toBeInViewport({ ratio: 1 });
}

test("a long panel scrolls its body on a desktop screen", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await expectBodyScrolls(page);
});

test.describe("phone", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

  test("a long panel scrolls its body on a phone", async ({ page }) => {
    await expectBodyScrolls(page);
  });
});
