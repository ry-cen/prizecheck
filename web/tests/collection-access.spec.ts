import { expect, type Page } from "@playwright/test";
import { signInAsOwner } from "./support/sign-in";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { startAsNewOwner } from "./support/owner";
import { expectTouchTarget } from "./support/touch-target";
import { test, artUpstream } from "./support/art-upstream";

type TreeNode = { id: string; name: string; version: number };

// Helpers copied from workspace-gallery.spec.ts so that spec stays untouched.

/** Replaces the catalog with one Printing per name (set "Fixture Set", number from the id),
 * each with artwork. This also clears every Holding, so All owned holds only what a test adds. */
function promoteCatalog(names: Record<string, string>) {
  execFileSync(
    ".venv/bin/python",
    [
      "-c",
      `import json, sys
import test_catalog_search as search
class Imaged(search.SearchSource):
    def fetch(self, source_id):
        record = super().fetch(source_id)
        record["image"] = "https://assets.tcgdex.net/en/fixture/" + source_id
        return record
search.SearchSource = Imaged
search.promote(json.loads(sys.argv[1]))`,
      JSON.stringify(names),
    ],
    { env: { ...process.env, PYTHONPATH: "api:api/tests" } }
  );
}

async function signIn(page: Page) {
  // Card art comes through the art route; the API fetches it from the art stub (a 1×1 PNG).
  (await artUpstream()).reset();
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query("DELETE FROM auth_send_event");
    await startAsNewOwner(pool);
  } finally {
    await pool.end();
  }
  await signInAsOwner(page, "/collection");
  await expect(page).toHaveURL(/\/collection$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("All owned");
}

/** Creates a Location through the API and returns its id. */
async function createLocation(
  page: Page,
  name: string,
  parentId: string | null
): Promise<string> {
  const api = (path: string) => new URL(path, page.url()).href;
  let parentVersion: number | null = null;
  if (parentId) {
    const tree = await page.request.get(api("/api/location-tree"));
    expect(tree.ok()).toBeTruthy();
    parentVersion = (
      (await tree.json()) as { locations: TreeNode[] }
    ).locations.find((node) => node.id === parentId)!.version;
  }
  const response = await page.request.post(api("/api/location-tree"), {
    headers: { origin: new URL(page.url()).origin },
    data: {
      name,
      parent_id: parentId,
      parent_version: parentVersion,
      idempotency_key: randomUUID(),
    },
  });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { location: TreeNode }).location.id;
}

/** Adds copies of an Edition to a Storage Leaf through the API. */
async function addCopies(
  page: Page,
  locationId: string,
  editionId: string,
  quantity: number
) {
  const response = await page.request.post(
    new URL("/api/holdings", page.url()).href,
    {
      headers: { origin: new URL(page.url()).origin },
      data: {
        location_id: locationId,
        edition_id: editionId,
        quantity: String(quantity),
        idempotency_key: randomUUID(),
      },
    }
  );
  expect(response.status(), await response.text()).toBe(200);
}

/** The normal-finish Edition of a fixture Printing. */
async function editionOf(sourceId: string): Promise<string> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const { rows } = await pool.query(
      `SELECT e.id FROM catalog_edition e JOIN catalog_printing p ON p.id=e.printing_id
       WHERE p.source_id=$1 AND e.descriptor->>'finish'='normal'`,
      [sourceId]
    );
    return rows[0].id;
  } finally {
    await pool.end();
  }
}

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 375, height: 812 },
]) {
  test.describe(`${viewport.width}px Collection access`, () => {
    test.use({ viewport });
    test("one Tab reaches selection actions without breaking multiselect", async ({
      page,
    }) => {
      promoteCatalog({ "card-1": "Access Abra" });
      await signIn(page);
      const location = await createLocation(page, "Access binder", null);
      await addCopies(page, location, await editionOf("card-1"), 3);
      await page.reload();
      const tiles = page.locator("[data-gallery-tile]");
      await expect(tiles).toHaveCount(3);
      if (viewport.width < 600)
        await page.getByRole("button", { name: "Select", exact: true }).click();
      await expect(
        page.getByRole("link", { name: "Go to selection actions", exact: true })
      ).toHaveCount(0);
      await tiles.first().focus();
      await page.keyboard.press("Space");
      await expect(tiles.first()).toBeFocused();
      const jump = page.getByRole("link", {
        name: "Go to selection actions",
        exact: true,
      });
      await expect(jump).toHaveCount(1);
      await expect(jump).not.toBeInViewport();
      await page.keyboard.press("Tab");
      await expect(jump).toBeFocused();
      await expect(jump).toBeInViewport();
      await page.keyboard.press("Enter");
      await expect(
        page.getByRole("button", { name: "Actions", exact: true })
      ).toBeFocused();
      await page.getByRole("button", { name: "Actions", exact: true }).click();
      await page
        .getByRole("group", { name: "Actions" })
        .getByRole("button", { name: "Move…", exact: true })
        .click();
      await expect(
        page.getByRole("dialog", { name: "Move 1 copy", exact: true })
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(
        page.getByRole("button", { name: "Actions", exact: true })
      ).toBeFocused();
      await expect(tiles.first()).toHaveAttribute("aria-pressed", "true");
      await tiles.nth(1).focus();
      await page.keyboard.press("Space");
      await expect(tiles.first()).toHaveAttribute("aria-pressed", "true");
      await expect(tiles.nth(1)).toHaveAttribute("aria-pressed", "true");
      await expect(jump).toHaveCount(1);
      await expect(tiles.nth(1)).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(jump).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(tiles.nth(2)).toBeFocused();
      await expect(jump).toHaveCount(0);
      // Moving back to either selected tile restores exactly one adjacent shortcut.
      await tiles.first().focus();
      await expect(jump).toHaveCount(1);
      await page.keyboard.press("Tab");
      await expect(jump).toBeFocused();
    });

    test("empty search explains matching counts and can be cleared", async ({
      page,
    }) => {
      promoteCatalog({ "card-1": "Access Abra" });
      await signIn(page);
      const location = await createLocation(page, "Access binder", null);
      await addCopies(page, location, await editionOf("card-1"), 1);
      await page.reload();
      await page
        .getByRole("searchbox", { name: "Search cards", exact: true })
        .fill("missingxyz");
      await expect(
        page.getByText("No copies match your search or filters.", {
          exact: true,
        })
      ).toBeVisible();
      await expect(
        page.getByText("0 matching copies · 0 matching editions", {
          exact: true,
        })
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Clear search and filters", exact: true })
        .click();
      await expect(page.locator("[data-gallery-tile]")).toHaveCount(1);
      // A filter-only empty result offers the same recovery, including in the phone drawer.
      await page.getByRole("button", { name: /^Filters/ }).click();
      await page
        .getByLabel("Category", { exact: true })
        .selectOption("Trainer");
      if (viewport.width < 600)
        await page
          .getByRole("button", { name: "Close filters & display", exact: true })
          .click();
      await expect(
        page.getByText("No copies match your search or filters.", {
          exact: true,
        })
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Clear search and filters", exact: true })
        .click();
      await expect(page.locator("[data-gallery-tile]")).toHaveCount(1);
    });
  });
}

test("Location names wrap only in the desktop sidebar", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  promoteCatalog({ "card-1": "Access Abra" });
  await signIn(page);
  const name = "Everyday binder with favourite Pokémon and spare cards";
  await createLocation(page, name, null);
  await page.reload();
  const rowLabel = page.getByText(name, { exact: true }).first();
  await expect(rowLabel).toBeVisible();
  await expect
    .poll(() =>
      rowLabel.evaluate((el) =>
        Math.round(
          el.getBoundingClientRect().height /
            parseFloat(getComputedStyle(el).lineHeight)
        )
      )
    )
    .toBe(2);
  await page.setViewportSize({ width: 375, height: 812 });
  const opener = page.getByRole("button", {
    name: "Open locations",
    exact: true,
  });
  await opener.click();
  const drawer = page.getByRole("dialog", { name: "Locations", exact: true });
  const row = drawer.getByRole("link", { name, exact: true });
  const phoneLabel = row.locator("[data-location-name]");
  await expect(phoneLabel).toHaveCSS("white-space", "nowrap");
  await expect(phoneLabel).toHaveCSS("text-overflow", "ellipsis");
  await expect
    .poll(() =>
      phoneLabel.evaluate((element) =>
        Math.round(
          element.getBoundingClientRect().height /
            parseFloat(getComputedStyle(element).lineHeight)
        )
      )
    )
    .toBe(1);
  await expectTouchTarget(row);
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await expect(opener).toBeFocused();
});
