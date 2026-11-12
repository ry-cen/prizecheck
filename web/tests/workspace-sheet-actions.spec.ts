import { expect, mergeTests, type Page } from "@playwright/test";
import { signInAsOwner } from "./support/sign-in";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { startAsNewOwner } from "./support/owner";
import { expectPageChecks } from "./support/page-check";
import { test as artTest, artUpstream } from "./support/art-upstream";
import { test as collectorsTest } from "./support/collectors";
import { befriend, lendHandedOver, nameCollector } from "./support/loans";

const test = mergeTests(artTest, collectorsTest);

type TreeNode = { id: string; name: string; version: number };

// Helpers copied from workspace-selection.spec.ts so that spec stays untouched.

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

test.use({ viewport: { width: 375, height: 812 } });

const tiles = (page: Page) =>
  page.getByRole("region", { name: "Cards" }).getByRole("button");
const sheet = (page: Page) =>
  page.getByRole("dialog", { name: "Sheet Abra", exact: true });

test("sheet shortcuts confirm one copy, restore selection on cancel, and offer Undo", async ({
  page,
}) => {
  promoteCatalog({ "card-1": "Sheet Abra" });
  await signIn(page);
  const source = await createLocation(page, "Source binder", null);
  await createLocation(page, "Destination binder", null);
  await addCopies(page, source, await editionOf("card-1"), 3);
  await page.reload();
  await expect(tiles(page)).toHaveCount(3);
  await tiles(page).first().click();
  await expectPageChecks(page, "card sheet actions");
  await sheet(page).getByRole("button", { name: "Move…", exact: true }).click();
  const move = page.getByRole("dialog", { name: "Move 1 copy", exact: true });
  await expect(move.getByRole("searchbox")).toBeFocused();
  await move.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    sheet(page).getByRole("button", { name: "Move…", exact: true })
  ).toBeFocused();
  await sheet(page)
    .getByRole("button", { name: "Remove…", exact: true })
    .click();
  const removal = page.getByRole("dialog", {
    name: "Remove 1 copy from your Collection",
    exact: true,
  });
  await expect(
    removal.getByRole("button", { name: "Cancel", exact: true })
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(
    sheet(page).getByRole("button", { name: "Remove…", exact: true })
  ).toBeFocused();
  await sheet(page).getByRole("button", { name: "Close details" }).click();
  await expect(page.getByRole("region", { name: "Selection" })).toHaveCount(0);
  await expect(tiles(page)).toHaveCount(3);
  await tiles(page).first().click();
  await sheet(page).getByRole("button", { name: "Move…", exact: true }).click();
  await move
    .getByRole("button", { name: "Destination binder", exact: true })
    .click();
  await expectPageChecks(page, "move from card sheet");
  await move.getByRole("button", { name: "Move 1 copy", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Notifications" })
  ).toContainText("Moved 1 copy to Destination binder.");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Notifications" })
  ).toContainText("Undo restored 1 copy");
  await expect(tiles(page)).toHaveCount(3);
  await tiles(page).first().click();
  await sheet(page)
    .getByRole("button", { name: "Remove…", exact: true })
    .click();
  await removal
    .getByRole("button", { name: "Remove 1 copy", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(tiles(page)).toHaveCount(2);
  await expect(
    page.getByRole("region", { name: "Notifications" })
  ).toContainText("Removed 1 copy");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(tiles(page)).toHaveCount(3);
});

test("a Borrowed Copy has Move but no Remove shortcut", async ({
  page,
  collectors,
}) => {
  promoteCatalog({ "card-1": "Sheet Abra" });
  const lender = (await collectors.signIn()).page;
  await nameCollector(lender, "Sam");
  const source = await createLocation(lender, "Lender binder", null);
  const edition = await editionOf("card-1");
  await addCopies(lender, source, edition, 2);
  await signIn(page);
  await nameCollector(page, "Jordan");
  await befriend(lender, page);
  await lendHandedOver(lender, page, [[edition, 2]]);
  await page.reload();
  await expect(tiles(page)).toHaveCount(2);
  await tiles(page).first().click();
  await expect(
    sheet(page).getByRole("button", { name: "Move…", exact: true })
  ).toBeVisible();
  await expect(
    sheet(page).getByRole("button", { name: "Remove…", exact: true })
  ).toHaveCount(0);
  await expectPageChecks(page, "borrowed card sheet");
  await createLocation(page, "Borrowed destination", null);
  await sheet(page).getByRole("button", { name: "Close details" }).click();
  await page.reload();
  await tiles(page).first().click();
  await sheet(page).getByRole("button", { name: "Move…", exact: true }).click();
  const move = page.getByRole("dialog", { name: "Move 1 copy", exact: true });
  await move
    .getByRole("button", { name: "Borrowed destination", exact: true })
    .click();
  await move.getByRole("button", { name: "Move 1 copy", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Notifications" })
  ).toContainText("Moved 1 copy to Borrowed destination.");
  await expect(
    page.getByRole("button", { name: "Undo", exact: true })
  ).toHaveCount(0);
});

test("cancelling a sheet action preserves an existing multi-copy selection", async ({
  page,
}) => {
  promoteCatalog({ "card-1": "Sheet Abra" });
  await signIn(page);
  const source = await createLocation(page, "Selection binder", null);
  await addCopies(page, source, await editionOf("card-1"), 3);
  await page.reload();
  await expect(tiles(page)).toHaveCount(3);
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await tiles(page).nth(0).click();
  await tiles(page).nth(1).click();
  const selection = page.getByRole("region", { name: "Selection" });
  await expect(selection).toContainText("2 copies selected");
  await selection.getByRole("button", { name: "Details", exact: true }).click();
  await sheet(page).getByRole("button", { name: "Move…", exact: true }).click();
  const move = page.getByRole("dialog", { name: "Move 1 copy", exact: true });
  await move.getByRole("button", { name: "Cancel", exact: true }).click();
  await sheet(page).getByRole("button", { name: "Close details" }).click();
  await expect(selection).toContainText("2 copies selected");
  await expect(
    page
      .getByRole("region", { name: "Cards" })
      .getByRole("button", { pressed: true })
  ).toHaveCount(2);
});

for (const cause of ["breakpoint", "Back"] as const) {
  test(`${cause} while a sheet action is open releases the final scroll lock`, async ({
    page,
  }) => {
    promoteCatalog({ "card-1": "Sheet Abra" });
    await signIn(page);
    const source = await createLocation(page, "Scroll binder", null);
    await addCopies(page, source, await editionOf("card-1"), 2);
    await page.reload();
    await expect(tiles(page)).toHaveCount(2);
    await tiles(page).first().click();
    await sheet(page)
      .getByRole("button", { name: "Move…", exact: true })
      .click();
    const move = page.getByRole("dialog", { name: "Move 1 copy", exact: true });
    await expect(move).toBeVisible();
    if (cause === "breakpoint")
      await page.setViewportSize({ width: 1280, height: 800 });
    else await page.goBack();
    await expect(sheet(page)).toHaveCount(0);
    await expect(move).toBeVisible();
    await expect(page.locator("body")).toHaveCSS("overflow", "hidden");
    await move.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator("body")).not.toHaveCSS("overflow", "hidden");
  });
}
