import { expect, mergeTests, type Page } from "@playwright/test";
import { signInAsOwner } from "./support/sign-in";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { startAsNewOwner } from "./support/owner";
import { test as artTest, artUpstream } from "./support/art-upstream";
import { test as collectorsTest } from "./support/collectors";

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

for (const phone of [true, false]) {
  test.describe(phone ? "touch phone" : "desktop", () => {
    test.use({
      viewport: phone
        ? { width: 375, height: 812 }
        : { width: 1280, height: 800 },
      isMobile: phone,
      hasTouch: phone,
    });
    test("stale detail Move stays reachable and retries exactly once", async ({
      page,
    }, testInfo) => {
      promoteCatalog({ "card-1": "Retry Abra" });
      await signIn(page);
      const source = await createLocation(page, "Source binder", null);
      const destination = await createLocation(
        page,
        "Destination binder",
        null
      );
      const edition = await editionOf("card-1");
      await addCopies(page, source, edition, 1);
      await page.reload();
      const tiles = (p: Page) =>
        p
          .getByRole("region", { name: "Cards", includeHidden: true })
          .getByRole("button", { includeHidden: true });
      await expect(tiles(page)).toHaveCount(1);
      await tiles(page).first().click();
      if (phone) {
        await testInfo.attach("pointer-media", {
          body: JSON.stringify(
            await page.evaluate(() => ({
              coarse: matchMedia("(pointer: coarse)").matches,
              noHover: matchMedia("(hover: none)").matches,
            }))
          ),
          contentType: "application/json",
        });
        await page
          .getByRole("dialog", { name: "Retry Abra", exact: true })
          .getByRole("button", { name: "Move…", exact: true })
          .click();
      } else {
        const bar = page.getByRole("region", { name: "Selection" });
        await bar.getByRole("button", { name: "Actions", exact: true }).click();
        await bar.getByRole("button", { name: "Move…", exact: true }).click();
      }
      const move = page.getByRole("dialog", {
        name: "Move 1 copy",
        exact: true,
      });
      await move
        .getByRole("button", { name: "Destination binder", exact: true })
        .click();
      // A second session moves and undoes the same Holding, changing its version.
      const other = await page.context().newPage();
      await other.setViewportSize({ width: 1280, height: 800 });
      await other.goto(new URL("/collection", page.url()).href);
      await expect(tiles(other)).toHaveCount(1);
      await tiles(other).first().click();
      const bar = other.getByRole("region", { name: "Selection" });
      await bar.getByRole("button", { name: "Actions", exact: true }).click();
      await bar.getByRole("button", { name: "Move…", exact: true }).click();
      const otherMove = other.getByRole("dialog", {
        name: "Move 1 copy",
        exact: true,
      });
      await otherMove
        .getByRole("button", { name: "Destination binder", exact: true })
        .click();
      await otherMove
        .getByRole("button", { name: "Move 1 copy", exact: true })
        .click();
      await other.getByRole("button", { name: "Undo", exact: true }).click();
      await expect(
        other.getByRole("region", { name: "Notifications" })
      ).toContainText("Undo restored 1 copy");
      await other.close();
      const confirm = move.getByRole("button", {
        name: "Move 1 copy",
        exact: true,
      });
      const refreshed = page.waitForResponse(
        (r) => new URL(r.url()).pathname === "/api/collection/holdings"
      );
      await confirm.click();
      await refreshed;
      await expect(move.getByRole("alert")).toContainText("Nothing moved.");
      await expect(move.getByRole("alert")).toContainText("try again");
      await expect(tiles(page)).toHaveCount(1);
      await expect(confirm).toBeEnabled();
      await expect
        .poll(() =>
          confirm.evaluate((button) => {
            const r = button.getBoundingClientRect();
            const hit = document.elementFromPoint(
              r.x + r.width / 2,
              r.y + r.height / 2
            );
            return {
              hit: hit === button || button.contains(hit),
              modal: hit?.closest("dialog") === button.closest("dialog"),
              focus: button.closest("dialog")?.contains(document.activeElement),
            };
          })
        )
        .toEqual({ hit: true, modal: true, focus: true });
      if (phone) await confirm.tap();
      else await confirm.click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(
        page.getByRole("region", { name: "Notifications" })
      ).toContainText("Moved 1 copy to Destination binder.");
      const pool = new Pool({ connectionString: process.env.DATABASE_URL });
      try {
        const { rows } = await pool.query(
          "SELECT location_id, quantity FROM holding WHERE edition_id=$1",
          [edition]
        );
        expect(rows).toEqual([
          expect.objectContaining({ location_id: destination, quantity: "1" }),
        ]);
      } finally {
        await pool.end();
      }
      await page.getByRole("button", { name: "Undo", exact: true }).click();
      await expect(
        page.getByRole("region", { name: "Notifications" })
      ).toContainText("Undo restored 1 copy");
    });
  });
}
