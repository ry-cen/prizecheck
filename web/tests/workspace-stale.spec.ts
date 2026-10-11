import { test, expect, type Locator, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";

type TreeNode = { id: string; name: string; version: number };

// Helpers copied from workspace-actions.spec.ts so that spec stays untouched.

// A 1×1 PNG stands in for card artwork, so no test reaches the network.
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64"
);

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

function messages(path: string): string[] {
  try {
    return readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

async function signIn(page: Page) {
  await page.route(/^https:\/\/assets\.tcgdex\.net\//, (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: PIXEL })
  );
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query("DELETE FROM auth_send_event");
  } finally {
    await pool.end();
  }
  const mail = process.env.MAIL_FILE || "/tmp/tcg-ticket01-mail";
  const before = messages(mail).length;
  await page.goto(
    `${process.env.TEST_ORIGIN || "http://localhost:5173"}/workspace`
  );
  await page
    .getByLabel("Email")
    .fill(process.env.OWNER_EMAIL || "owner@example.test");
  await page.getByRole("button", { name: "Send code" }).click();
  await expect.poll(() => messages(mail).length).toBeGreaterThan(before);
  await page
    .getByLabel("Six-digit code")
    .fill(JSON.parse(messages(mail).at(-1)!).otp);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/workspace$/);
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

const cards = (page: Page) => page.getByRole("region", { name: "Cards" });
const tiles = (page: Page) => cards(page).getByRole("button");
const bar = (page: Page) => page.getByRole("region", { name: "Selection" });
/** The toast's live status line (ticket 107). */
const toast = (page: Page) =>
  page.getByRole("status").filter({ hasText: /Moved|Removed|Undo|Dismissed/ });

async function box(locator: Locator) {
  const found = await locator.boundingBox();
  expect(found).not.toBeNull();
  return found!;
}

async function openActions(page: Page, item: string) {
  await bar(page).getByRole("button", { name: "Actions" }).click();
  await bar(page).getByRole("button", { name: item }).click();
}

const focusedId = (page: Page) =>
  page.evaluate(() => document.activeElement?.id ?? "");

// Ticket 113's copy.
const STALE = "Your collection changed in another tab or session.";
const NOTE =
  "Collection reloaded. Your selection was cleared because some selected cards had changed.";
const banner = (page: Page) =>
  page.getByRole("status").filter({ hasText: STALE });
const note = (page: Page) => page.getByRole("status").filter({ hasText: NOTE });
const reload = (page: Page) =>
  page.getByRole("button", { name: "Reload", exact: true });

/** A second tab of the same session, open at All owned with its artwork stubbed. */
async function secondTab(page: Page): Promise<Page> {
  const other = await page.context().newPage();
  await other.route(/^https:\/\/assets\.tcgdex\.net\//, (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: PIXEL })
  );
  await other.setViewportSize({ width: 1280, height: 860 });
  await other.goto(page.url());
  await expect(other.getByRole("heading", { level: 1 })).toHaveText(
    "All owned"
  );
  return other;
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1280, height: 860 } });

  test("a change from a second tab shows the banner without refreshing; Reload refreshes, clears the selection and notes the changed copies", async ({
    page,
  }) => {
    promoteCatalog({ "card-1": "Banner Abra", "card-2": "Banner Pikachu" });
    await signIn(page);
    const s = randomUUID().slice(0, 8);
    const alpha = await createLocation(page, `Alpha ${s}`, null);
    const beta = await createLocation(page, `Beta ${s}`, null);
    await addCopies(page, alpha, await editionOf("card-1"), 1);
    await addCopies(page, beta, await editionOf("card-2"), 2);
    await page.reload();
    // Display order: Abra·Alpha, Pikachu·Beta ×2.
    await expect(tiles(page)).toHaveCount(3);
    await expect(page.getByRole("main")).toContainText("3 copies · 2 editions");
    await tiles(page).nth(0).click();
    await tiles(page)
      .nth(1)
      .click({ modifiers: ["ControlOrMeta"] });
    await expect(bar(page)).toContainText("2 copies selected");

    // The second tab removes one Pikachu from the Collection.
    const other = await secondTab(page);
    await expect(tiles(other)).toHaveCount(3);
    await tiles(other).nth(1).click();
    await openActions(other, "Inventory Removal…");
    await other
      .getByRole("dialog", { name: "Remove 1 copy from your Collection" })
      .getByRole("button", { name: "Remove 1 copy" })
      .click();
    await expect(toast(other)).toHaveText(
      "Removed 1 copy from your Collection."
    );
    await expect(tiles(other)).toHaveCount(2);
    // The tab that made the change shows no banner.
    await expect(banner(other)).toHaveCount(0);

    // This tab says so and offers Reload, but nothing refreshes by itself.
    await expect(banner(page)).toHaveText(STALE);
    await expect(reload(page)).toBeVisible();
    await expect(tiles(page)).toHaveCount(3);
    await expect(page.getByRole("main")).toContainText("3 copies · 2 editions");
    await expect(bar(page)).toContainText("2 copies selected");
    // The banner sits above the gallery.
    expect((await box(reload(page))).y).toBeLessThan(
      (await box(tiles(page).nth(0))).y
    );

    // Reload refetches, clears the selection and notes that selected copies had changed.
    await reload(page).click();
    await expect(tiles(page)).toHaveCount(2);
    await expect(page.getByRole("main")).toContainText("2 copies · 2 editions");
    await expect(bar(page)).toHaveCount(0);
    await expect(note(page)).toHaveText(NOTE);
    await expect(banner(page)).toHaveCount(0);
    expect(await focusedId(page)).toBe("ws-heading");
    await page.getByRole("button", { name: "Dismiss note" }).click();
    await expect(note(page)).toHaveCount(0);
    expect(await focusedId(page)).toBe("ws-heading");
    await other.close();
  });

  test("an action on out-of-date tiles fails safely, and its refresh replaces the banner", async ({
    page,
  }) => {
    promoteCatalog({ "card-1": "Banner Abra", "card-2": "Banner Pikachu" });
    await signIn(page);
    const s = randomUUID().slice(0, 8);
    const alpha = await createLocation(page, `Alpha ${s}`, null);
    const beta = await createLocation(page, `Beta ${s}`, null);
    await createLocation(page, `Dest ${s}`, null);
    await addCopies(page, alpha, await editionOf("card-1"), 1);
    await addCopies(page, beta, await editionOf("card-2"), 2);
    await page.reload();
    await expect(tiles(page)).toHaveCount(3);
    // Both Pikachu copies.
    await tiles(page).nth(1).click();
    await tiles(page)
      .nth(2)
      .click({ modifiers: ["Shift"] });
    await expect(bar(page)).toContainText("2 copies selected");

    // The second tab removes one of them.
    const other = await secondTab(page);
    await expect(tiles(other)).toHaveCount(3);
    await tiles(other).nth(1).click();
    await openActions(other, "Inventory Removal…");
    await other.getByRole("button", { name: "Remove 1 copy" }).click();
    await expect(toast(other)).toHaveText(
      "Removed 1 copy from your Collection."
    );
    // Its own reload has landed (and been shared) before it closes.
    await expect(tiles(other)).toHaveCount(2);
    await other.close();
    await expect(banner(page)).toHaveText(STALE);

    // Moving the out-of-date selection anyway fails on the API's stale check and changes nothing.
    await openActions(page, "Move…");
    const dialog = page.getByRole("dialog", { name: "Move 2 copies" });
    await dialog
      .getByRole("searchbox", { name: "Search locations" })
      .fill(`Dest ${s}`);
    await dialog
      .getByRole("button", { name: `Dest ${s}`, exact: true })
      .click();
    await dialog.getByRole("button", { name: "Move 2 copies" }).click();
    // The refreshed selection renames the dialog ("Move 1 copy"), so find it by role alone.
    const open = page.getByRole("dialog");
    const alert = open.getByRole("alert");
    await expect(alert).toContainText(`Beta ${s}`);
    await expect(alert).toContainText("Banner Pikachu");
    await expect(alert).toContainText("Nothing moved.");
    await open.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    // Ticket 107's announced refresh replaces the banner: the gallery and tree are current, and the
    // kept selection fits what is left.
    await expect(tiles(page)).toHaveCount(2);
    await expect(banner(page)).toHaveCount(0);
    await expect(reload(page)).toHaveCount(0);
    await expect(bar(page)).toContainText("1 copy selected");
    await page
      .getByRole("complementary", { name: "Sidebar" })
      .getByRole("navigation", { name: "Locations" })
      .getByRole("button", { name: `Dest ${s}`, exact: true })
      .click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      `Dest ${s}`
    );
    await expect(page.getByRole("main")).toContainText(
      "This Location has no cards."
    );
  });

  test("a change from another session shows the banner when the tab regains focus; Reload with unchanged selected copies adds no note", async ({
    page,
  }) => {
    promoteCatalog({ "card-1": "Banner Abra", "card-2": "Banner Pikachu" });
    await signIn(page);
    const s = randomUUID().slice(0, 8);
    const alpha = await createLocation(page, `Alpha ${s}`, null);
    const beta = await createLocation(page, `Beta ${s}`, null);
    const pikachu = await editionOf("card-2");
    await addCopies(page, alpha, await editionOf("card-1"), 1);
    await addCopies(page, beta, pikachu, 1);
    await page.reload();
    await expect(tiles(page)).toHaveCount(2);
    await tiles(page).nth(0).click();
    await expect(bar(page)).toContainText("1 copy selected");

    // Another session (here the API, which no tab of this browser hears about) adds a Pikachu.
    await addCopies(page, beta, pikachu, 1);
    await expect(banner(page)).toHaveCount(0);
    // Coming back to the tab checks the owner revision.
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(banner(page)).toHaveText(STALE);
    await expect(tiles(page)).toHaveCount(2);

    await reload(page).click();
    await expect(tiles(page)).toHaveCount(3);
    await expect(page.getByRole("main")).toContainText("3 copies · 2 editions");
    await expect(bar(page)).toHaveCount(0);
    await expect(banner(page)).toHaveCount(0);
    // The selected Abra didn't change, so there is no note.
    await expect(
      page.getByRole("button", { name: "Dismiss note" })
    ).toHaveCount(0);
    await expect(note(page)).toHaveCount(0);
    expect(await focusedId(page)).toBe("ws-heading");
  });
});

test.describe("mobile", () => {
  test.use({
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
  });

  test("the banner sits above the gallery and Reload is a touch-sized target", async ({
    page,
  }) => {
    promoteCatalog({ "card-1": "Banner Abra" });
    await signIn(page);
    const s = randomUUID().slice(0, 8);
    const alpha = await createLocation(page, `Alpha ${s}`, null);
    const abra = await editionOf("card-1");
    await addCopies(page, alpha, abra, 1);
    await page.reload();
    await expect(tiles(page)).toHaveCount(1);

    await addCopies(page, alpha, abra, 1);
    await page.evaluate(() =>
      document.dispatchEvent(new Event("visibilitychange"))
    );
    await expect(banner(page)).toHaveText(STALE);
    const button = await box(reload(page));
    expect(button.height).toBeGreaterThanOrEqual(44);
    expect(button.y + button.height).toBeLessThanOrEqual(
      (await box(tiles(page).nth(0))).y
    );
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth)
    ).toBeLessThanOrEqual(375);
    await reload(page).tap();
    await expect(tiles(page)).toHaveCount(2);
    await expect(banner(page)).toHaveCount(0);
  });
});
