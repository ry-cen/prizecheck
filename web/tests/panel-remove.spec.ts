import { expect, mergeTests, type Locator, type Page } from "@playwright/test";
import { signInAsOwner } from "./support/sign-in";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { startAsNewOwner } from "./support/owner";
import { test as artTest, artUpstream } from "./support/art-upstream";
import { test as collectorsTest } from "./support/collectors";

const test = mergeTests(artTest, collectorsTest);

type TreeNode = { id: string; name: string; version: number };

// Helpers copied from collection-aside.spec.ts so that spec stays untouched.

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

test.use({ viewport: { width: 1280, height: 800 } });

const tiles = (page: Page) =>
  page.getByRole("region", { name: "Cards" }).getByRole("button");
const aside = (page: Page) =>
  page.getByRole("complementary", { name: "Card details" });
const bar = (page: Page) => page.getByRole("region", { name: "Selection" });
const toasts = (page: Page) =>
  page.getByRole("region", { name: "Notifications" });

/** True when a press at the element's centre lands on it: nothing paints over it. */
const onTop = (locator: Locator) =>
  locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(
      box.left + box.width / 2,
      box.top + box.height / 2
    );
    return !!hit && (hit === element || element.contains(hit));
  });

/** Six copies in one binder, one of them removed from the selection bar, so its Undo toast is showing and
 * five copies are left to select. */
async function sixCopiesOneRemoved(page: Page) {
  promoteCatalog({ "card-1": "Panel Abra" });
  await signIn(page);
  const binder = await createLocation(page, "Panel binder", null);
  await addCopies(page, binder, await editionOf("card-1"), 6);
  await page.reload();
  await expect(tiles(page)).toHaveCount(6);
  await tiles(page).first().click();
  await bar(page).getByRole("button", { name: "Actions" }).click();
  await bar(page).getByRole("button", { name: "Remove…", exact: true }).click();
  await page
    .getByRole("dialog", {
      name: "Remove 1 copy from your Collection",
      exact: true,
    })
    .getByRole("button", { name: "Remove 1 copy", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(tiles(page)).toHaveCount(5);
  await expect(toasts(page)).toContainText("Removed 1 copy");
}

/** Adds the other four tiles to a selection that already holds the first. */
async function addTheOtherFour(page: Page) {
  for (let index = 1; index < 5; index++)
    await tiles(page)
      .nth(index)
      .click({ modifiers: ["ControlOrMeta"] });
  await expect(bar(page)).toContainText("5 copies selected");
}

async function selectAllFive(page: Page) {
  await tiles(page).first().click();
  await addTheOtherFour(page);
}

test("with several copies selected the panel offers no Move… or Remove…, and the selection bar is where to act", async ({
  page,
}) => {
  await sixCopiesOneRemoved(page);
  await tiles(page).first().click();
  // One copy selected: the panel acts on it, under the same name as the Actions menu.
  await expect(
    aside(page).getByRole("button", { name: "Move…", exact: true })
  ).toBeVisible();
  await expect(
    aside(page).getByRole("button", { name: "Remove…", exact: true })
  ).toBeVisible();
  await bar(page).getByRole("button", { name: "Actions" }).click();
  await expect(
    bar(page).getByRole("button", { name: "Remove…", exact: true })
  ).toBeVisible();
  await bar(page).getByRole("button", { name: "Actions" }).click();

  await addTheOtherFour(page);
  await expect(aside(page)).toContainText("Panel Abra");
  await expect(aside(page).getByRole("button")).toHaveCount(0);
  await expect(
    aside(page).getByRole("button", { name: "Remove…" })
  ).toHaveCount(0);
  await bar(page).getByRole("button", { name: "Actions" }).click();
  await expect(
    bar(page).getByRole("button", { name: "Inventory Removal…" })
  ).toHaveCount(0);
  const remove = bar(page).getByRole("button", {
    name: "Remove…",
    exact: true,
  });
  await expect(remove).toBeVisible();
  // The one Remove… acts on all five.
  await remove.click();
  await expect(
    page.getByRole("dialog", {
      name: "Remove 5 copies from your Collection",
      exact: true,
    })
  ).toBeVisible();
  await page.keyboard.press("Escape");
  // Back to one copy selected, the panel offers its actions again.
  await bar(page).getByRole("button", { name: "Actions" }).click();
  await bar(page).getByRole("button", { name: "Clear selection" }).click();
  await tiles(page).first().click();
  await expect(
    aside(page).getByRole("button", { name: "Remove…", exact: true })
  ).toBeVisible();
});

test("the open Actions menu and the Undo toast do not cover each other", async ({
  page,
}) => {
  await sixCopiesOneRemoved(page);
  await selectAllFive(page);
  const actions = bar(page).getByRole("button", { name: "Actions" });
  await actions.click();
  await expect(actions).toHaveAttribute("aria-expanded", "true");
  const undo = toasts(page).getByRole("button", { name: "Undo", exact: true });
  const message = toasts(page).getByText("Removed 1 copy");
  const items = ["Move…", "Remove…", "Lend to a Friend…", "Clear selection"];
  for (const name of items)
    await expect
      .poll(
        () => onTop(bar(page).getByRole("button", { name, exact: true })),
        name
      )
      .toBe(true);
  // The toast is clear of the menu too: its message and Undo are reachable, and it sits above the menu.
  await expect.poll(() => onTop(undo), "Undo").toBe(true);
  await expect.poll(() => onTop(message), "message").toBe(true);
  const menu = await bar(page)
    .getByRole("group", { name: "Actions" })
    .boundingBox();
  const toast = await message.boundingBox();
  expect(menu).not.toBeNull();
  expect(toast).not.toBeNull();
  expect(toast!.y + toast!.height).toBeLessThanOrEqual(menu!.y);
  // Closing the menu brings the toast back down to the bar.
  await actions.click();
  await expect(actions).toHaveAttribute("aria-expanded", "false");
  const bartop = (await bar(page).boundingBox())!.y;
  await expect
    .poll(async () => {
      const box = await message.boundingBox();
      return box ? box.y + box.height <= bartop : false;
    })
    .toBe(true);
  // Undo still works with the menu open.
  await actions.click();
  await undo.click();
  await expect(tiles(page)).toHaveCount(6);
});
