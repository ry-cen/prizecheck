import { test, expect, type Locator, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { expectTouchTarget } from "./support/touch-target";

type TreeNode = { id: string; name: string; version: number };

// Helpers copied from workspace-selection.spec.ts so that spec stays untouched.

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

/** Runs SQL against this worker's database (another tab's change). */
async function sql(text: string, values: unknown[]) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query(text, values);
  } finally {
    await pool.end();
  }
}

const cards = (page: Page) => page.getByRole("region", { name: "Cards" });
const tiles = (page: Page) => cards(page).getByRole("button");
const pressed = (page: Page) =>
  cards(page).getByRole("button", { pressed: true });
const bar = (page: Page) => page.getByRole("region", { name: "Selection" });
const sidebar = (page: Page) =>
  page
    .getByRole("complementary", { name: "Sidebar" })
    .getByRole("navigation", { name: "Locations" });
/** The toast's live status line. */
const toast = (page: Page) =>
  page.getByRole("status").filter({ hasText: /Moved|Removed|Undo|Dismissed/ });

async function box(locator: Locator) {
  const found = await locator.boundingBox();
  expect(found).not.toBeNull();
  return found!;
}

const center = async (locator: Locator) => {
  const b = await box(locator);
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};

/** Opens a Location from the sidebar and checks its heading counts (what the collector sees). */
async function expectCounts(page: Page, name: string, counts: string) {
  await sidebar(page).getByRole("button", { name, exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(name);
  await expect(page.getByRole("main")).toContainText(counts);
}

async function openActions(page: Page, item: string) {
  await bar(page).getByRole("button", { name: "Actions" }).click();
  await bar(page).getByRole("button", { name: item }).click();
}

const focusedId = (page: Page) =>
  page.evaluate(() => document.activeElement?.id ?? "");

test.describe("desktop", () => {
  test.use({ viewport: { width: 1280, height: 860 } });

  test("a selection spanning Storage Leaves moves through the explorer and one Undo restores every source", async ({
    page,
  }) => {
    promoteCatalog({
      "card-1": "Span Abra",
      "card-2": "Span Pikachu",
      "card-3": "Span Zubat",
    });
    await signIn(page);
    const s = randomUUID().slice(0, 8);
    const alpha = await createLocation(page, `Alpha ${s}`, null);
    const beta = await createLocation(page, `Beta ${s}`, null);
    const shelf = await createLocation(page, `Shelf ${s}`, null);
    const binder = await createLocation(page, `Binder ${s}`, shelf);
    const [abra, pikachu, zubat] = await Promise.all(
      ["card-1", "card-2", "card-3"].map(editionOf)
    );
    await addCopies(page, alpha, abra, 2);
    await addCopies(page, beta, pikachu, 2);
    await addCopies(page, binder, zubat, 1);
    await page.reload();
    // Display order: Abra·Alpha ×2, Pikachu·Beta ×2, Zubat·Binder.
    await expect(tiles(page)).toHaveCount(5);

    // Every selected copy already at the destination: confirmation is disabled.
    await tiles(page).nth(4).click();
    await openActions(page, "Move…");
    let dialog = page.getByRole("dialog", { name: "Move 1 copy" });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole("searchbox", { name: "Search locations" })
    ).toBeFocused();
    const folder = dialog.getByRole("button", {
      name: `Shelf ${s}`,
      exact: true,
    });
    await expect(folder).toHaveAttribute("aria-expanded", "false");
    await folder.click();
    await expect(folder).toHaveAttribute("aria-expanded", "true");
    await dialog
      .getByRole("button", { name: `Binder ${s}`, exact: true })
      .click();
    await expect(dialog).toContainText(`Shelf ${s} / Binder ${s}`);
    await expect(dialog).toContainText("Every selected copy is already here.");
    await expect(
      dialog.getByRole("button", { name: "Move", exact: true })
    ).toBeDisabled();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    // Cancel keeps the selection and returns focus to Actions.
    await expect(
      bar(page).getByRole("button", { name: "Actions" })
    ).toBeFocused();
    await expect(bar(page)).toContainText("1 copy selected");

    // Select everything: three Card Editions in three Storage Leaves.
    await tiles(page).nth(0).click();
    await tiles(page)
      .nth(4)
      .click({ modifiers: ["Shift"] });
    await expect(bar(page)).toContainText("5 copies selected");
    await expect(bar(page)).toContainText("3 editions · 3 locations");
    await openActions(page, "Move…");
    dialog = page.getByRole("dialog", { name: "Move 5 copies" });
    // Search finds a Storage Leaf by any part of its path; folders can't be chosen.
    await dialog
      .getByRole("searchbox", { name: "Search locations" })
      .fill(`shelf ${s}`);
    const match = dialog.getByRole("button", {
      name: `Shelf ${s} / Binder ${s}`,
      exact: true,
    });
    await expect(match).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: `Alpha ${s}` })
    ).toHaveCount(0);
    await match.click();
    await expect(match).toHaveAttribute("aria-pressed", "true");
    await expect(dialog).toContainText(
      "4 copies will move. 1 copy already here will stay."
    );
    await dialog.getByRole("button", { name: "Move 4 copies" }).click();

    // Success: the dialog closes, the selection clears and the toast offers Undo.
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(bar(page)).toHaveCount(0);
    await expect(toast(page)).toHaveText(
      `Moved 4 copies to Shelf ${s} / Binder ${s}. 1 copy already there stayed.`
    );
    expect(await focusedId(page)).toBe("ws-heading");
    await expectCounts(page, `Alpha ${s}`, "This Location has no cards.");
    await expectCounts(page, `Beta ${s}`, "This Location has no cards.");
    // Binder is inside the Shelf folder, collapsed in the sidebar.
    await sidebar(page)
      .getByRole("button", { name: `Shelf ${s}`, exact: true })
      .click();
    await expectCounts(page, `Binder ${s}`, "5 copies · 3 editions");

    // One Undo restores every source.
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(toast(page)).toHaveText(
      "Undo restored 4 copies to 2 locations."
    );
    await expect(
      page.getByRole("button", { name: "Undo", exact: true })
    ).toHaveCount(0);
    await expectCounts(page, `Binder ${s}`, "1 copy · 1 edition");
    await expectCounts(page, `Alpha ${s}`, "2 copies · 1 edition");
    await expectCounts(page, `Beta ${s}`, "2 copies · 1 edition");
  });

  test("dragging a selected tile carries the selection and an unselected tile carries only itself; a drop moves at once", async ({
    page,
  }) => {
    promoteCatalog({ "card-1": "Drag Abra", "card-2": "Drag Pikachu" });
    await signIn(page);
    const s = randomUUID().slice(0, 8);
    const alpha = await createLocation(page, `0 Alpha ${s}`, null);
    const beta = await createLocation(page, `0 Beta ${s}`, null);
    await createLocation(page, `0 Dest ${s}`, null);
    await addCopies(page, alpha, await editionOf("card-1"), 2);
    await addCopies(page, beta, await editionOf("card-2"), 1);
    await page.reload();
    // Display order: Abra·Alpha ×2, Pikachu·Beta.
    await expect(tiles(page)).toHaveCount(3);
    // Names starting "0 " sort first, so the rows are in view beside the tiles however many Locations
    // earlier specs left in this worker's database.
    const row = (name: string) =>
      sidebar(page).getByRole("button", { name, exact: true });

    // A selected tile carries the whole selection.
    await tiles(page).nth(0).click();
    await tiles(page)
      .nth(1)
      .click({ modifiers: ["ControlOrMeta"] });
    await expect(bar(page)).toContainText("2 copies selected");
    const from = await center(tiles(page).nth(0));
    const to = await center(row(`0 Dest ${s}`));
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 12 });
    await expect(
      page.getByText("2 copies · 1 edition", { exact: true })
    ).toBeVisible();
    // Valid leaves are outlined (dashed); the one under the pointer is ringed (solid). Alpha holds
    // every carried copy, so it isn't a target; All owned never is.
    await expect(row(`0 Dest ${s}`)).toHaveCSS("outline-style", "solid");
    await expect(row(`0 Beta ${s}`)).toHaveCSS("outline-style", "dashed");
    await expect(row(`0 Alpha ${s}`)).toHaveCSS("outline-style", "none");
    await expect(row("All owned")).toHaveCSS("outline-style", "none");
    await page.mouse.up();
    await expect(
      page.getByText("2 copies · 1 edition", { exact: true })
    ).toHaveCount(0);
    await expect(toast(page)).toHaveText(`Moved 2 copies to 0 Dest ${s}.`);
    await expect(bar(page)).toHaveCount(0);
    // The dragged tile unmounted with the selection: focus lands on the heading, not the page.
    expect(await focusedId(page)).toBe("ws-heading");
    await expect(
      page.getByRole("button", { name: "Undo", exact: true })
    ).toBeVisible();

    // An unselected tile carries only itself, even with another tile selected.
    await expect(tiles(page)).toHaveCount(3);
    // Display order: Abra·Dest ×2, Pikachu·Beta.
    await tiles(page).nth(0).click();
    await expect(bar(page)).toContainText("1 copy selected");
    const pikachu = await center(tiles(page).nth(2));
    const alphaRow = await center(row(`0 Alpha ${s}`));
    await page.mouse.move(pikachu.x, pikachu.y);
    await page.mouse.down();
    await page.mouse.move(alphaRow.x, alphaRow.y, { steps: 12 });
    await expect(
      page.getByText("1 copy · 1 edition", { exact: true })
    ).toBeVisible();
    await page.mouse.up();
    await expect(toast(page)).toHaveText(`Moved 1 copy to 0 Alpha ${s}.`);
    await expectCounts(page, `0 Dest ${s}`, "2 copies · 1 edition");
    await expectCounts(page, `0 Alpha ${s}`, "1 copy · 1 edition");
    await expectCounts(page, `0 Beta ${s}`, "This Location has no cards.");

    // Undo puts the dragged copy back.
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(toast(page)).toHaveText("Undo restored 1 copy to 1 location.");
    await expectCounts(page, `0 Beta ${s}`, "1 copy · 1 edition");
  });

  test("Inventory Removal confirms each Card Edition, quantity and source Location, and one Undo restores every source", async ({
    page,
  }) => {
    promoteCatalog({ "card-1": "Gone Abra", "card-2": "Gone Pikachu" });
    await signIn(page);
    const s = randomUUID().slice(0, 8);
    const alpha = await createLocation(page, `Alpha ${s}`, null);
    const beta = await createLocation(page, `Beta ${s}`, null);
    await addCopies(page, alpha, await editionOf("card-1"), 2);
    await addCopies(page, beta, await editionOf("card-2"), 1);
    await page.reload();
    await expect(tiles(page)).toHaveCount(3);

    await tiles(page).nth(0).click();
    await tiles(page)
      .nth(2)
      .click({ modifiers: ["Shift"] });
    await expect(bar(page)).toContainText("3 copies selected");
    await openActions(page, "Inventory Removal…");
    const dialog = page.getByRole("dialog", {
      name: "Remove 3 copies from your Collection",
    });
    await expect(dialog).toBeVisible();
    const list = dialog.getByRole("group", { name: "Copies to remove" });
    await expect(list).toContainText(`Alpha ${s}`);
    await expect(list).toContainText("2 × Gone Abra (Fixture Set 1)");
    await expect(list).toContainText(`Beta ${s}`);
    await expect(list).toContainText("1 × Gone Pikachu (Fixture Set 2)");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(bar(page)).toContainText("3 copies selected");
    await expect(tiles(page)).toHaveCount(3);

    await openActions(page, "Inventory Removal…");
    await dialog.getByRole("button", { name: "Remove 3 copies" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(toast(page)).toHaveText(
      "Removed 3 copies from your Collection."
    );
    await expect(bar(page)).toHaveCount(0);
    await expect(
      page.getByText("Your Collection has no cards yet.")
    ).toBeVisible();

    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(toast(page)).toHaveText(
      "Undo restored 3 copies to 2 locations."
    );
    await expect(tiles(page)).toHaveCount(3);
    await expectCounts(page, `Alpha ${s}`, "2 copies · 1 edition");
    await expectCounts(page, `Beta ${s}`, "1 copy · 1 edition");
  });

  test("an incompatible newest Undo shows as unavailable and can be dismissed to reach the older one", async ({
    page,
  }) => {
    promoteCatalog({ "card-1": "Older Abra" });
    await signIn(page);
    const s = randomUUID().slice(0, 8);
    const alpha = await createLocation(page, `Alpha ${s}`, null);
    await createLocation(page, `First ${s}`, null);
    const second = await createLocation(page, `Second ${s}`, null);
    await addCopies(page, alpha, await editionOf("card-1"), 2);
    await page.reload();
    await expect(tiles(page)).toHaveCount(2);

    async function moveFirstTileTo(name: string, count: string) {
      await tiles(page).nth(0).click();
      await openActions(page, "Move…");
      const dialog = page.getByRole("dialog", { name: "Move 1 copy" });
      await dialog
        .getByRole("searchbox", { name: "Search locations" })
        .fill(name);
      await dialog.getByRole("button", { name, exact: true }).click();
      await dialog.getByRole("button", { name: "Move 1 copy" }).click();
      await expect(toast(page)).toHaveText(`Moved 1 copy to ${name}.`);
      await expectCounts(page, name, count);
      await sidebar(page)
        .getByRole("button", { name: `Alpha ${s}`, exact: true })
        .click();
    }
    await moveFirstTileTo(`First ${s}`, "1 copy · 1 edition");
    await moveFirstTileTo(`Second ${s}`, "1 copy · 1 edition");

    // Another tab removes the copy the newest Move brought to Second.
    await sql(
      `WITH changed AS (
         UPDATE inventory_owner SET revision=revision+1
         WHERE user_id=(SELECT owner_id FROM location WHERE id=$1) RETURNING revision
       ) DELETE FROM holding WHERE location_id=$1`,
      [second]
    );
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(toast(page)).toContainText("Undo unavailable");
    await expect(toast(page)).toContainText("nothing was restored");
    await expect(
      page.getByRole("button", { name: "Undo unavailable" })
    ).toBeDisabled();
    // Nothing changed.
    await expectCounts(page, `First ${s}`, "1 copy · 1 edition");

    await page.getByRole("button", { name: "Dismiss Undo" }).click();
    await expect(toast(page)).toHaveText(
      "Dismissed. The earlier Move can be undone."
    );
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(toast(page)).toHaveText("Undo restored 1 copy to 1 location.");
    await expectCounts(page, `First ${s}`, "This Location has no cards.");
    await expectCounts(page, `Alpha ${s}`, "1 copy · 1 edition");
  });

  test("a stale selection fails without changes, keeps the selection and names the Location; a retry after the refresh moves it", async ({
    page,
  }) => {
    promoteCatalog({ "card-1": "Stale Abra", "card-2": "Stale Pikachu" });
    await signIn(page);
    const s = randomUUID().slice(0, 8);
    const alpha = await createLocation(page, `Alpha ${s}`, null);
    const beta = await createLocation(page, `Beta ${s}`, null);
    await createLocation(page, `Dest ${s}`, null);
    const pikachu = await editionOf("card-2");
    await addCopies(page, alpha, await editionOf("card-1"), 1);
    await addCopies(page, beta, pikachu, 2);
    await page.reload();
    await expect(tiles(page)).toHaveCount(3);
    await tiles(page).nth(0).click();
    await tiles(page)
      .nth(2)
      .click({ modifiers: ["Shift"] });
    await expect(bar(page)).toContainText("3 copies selected");

    // Another tab adds a Pikachu to Beta, so the selected Holding's version is stale.
    await sql(
      `WITH changed AS (
         UPDATE inventory_owner SET revision=revision+1
         WHERE user_id=(SELECT owner_id FROM location WHERE id=$1) RETURNING revision
       ) UPDATE holding SET quantity=quantity+1,version=(SELECT revision FROM changed)
         WHERE location_id=$1 AND edition_id=$2`,
      [beta, pikachu]
    );
    await openActions(page, "Move…");
    const dialog = page.getByRole("dialog", { name: "Move 3 copies" });
    await dialog
      .getByRole("searchbox", { name: "Search locations" })
      .fill(`Dest ${s}`);
    await dialog
      .getByRole("button", { name: `Dest ${s}`, exact: true })
      .click();
    await dialog.getByRole("button", { name: "Move 3 copies" }).click();
    const alert = dialog.getByRole("alert");
    await expect(alert).toContainText(`Beta ${s}`);
    await expect(alert).toContainText("Stale Pikachu");
    await expect(alert).toContainText("Nothing moved.");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    // The selection is kept; the refreshed gallery shows the new copy.
    await expect(tiles(page)).toHaveCount(4);
    await expect(bar(page)).toContainText("3 copies selected");
    await expect(pressed(page)).toHaveCount(3);

    // The retry stages the refreshed versions and succeeds.
    await openActions(page, "Move…");
    await dialog
      .getByRole("searchbox", { name: "Search locations" })
      .fill(`Dest ${s}`);
    await dialog
      .getByRole("button", { name: `Dest ${s}`, exact: true })
      .click();
    await dialog.getByRole("button", { name: "Move 3 copies" }).click();
    await expect(toast(page)).toHaveText(`Moved 3 copies to Dest ${s}.`);
    await expectCounts(page, `Beta ${s}`, "1 copy · 1 edition");
    await expectCounts(page, `Dest ${s}`, "3 copies · 2 editions");
  });

  /** Seeds two Alpha copies of one card and an empty "0 Dest" leaf. Names starting "0 " sort first,
   * so the sidebar rows are in view whatever earlier specs left in this worker's database. */
  async function seedAlphaAndDest(page: Page, card: string) {
    promoteCatalog({ "card-1": card });
    await signIn(page);
    const s = randomUUID().slice(0, 8);
    const alpha = await createLocation(page, `0 Alpha ${s}`, null);
    const dest = await createLocation(page, `0 Dest ${s}`, null);
    const edition = await editionOf("card-1");
    await addCopies(page, alpha, edition, 2);
    await page.reload();
    await expect(tiles(page)).toHaveCount(2);
    return { s, alpha, dest, edition };
  }

  async function moveFirstTileToDest(page: Page, s: string) {
    await tiles(page).nth(0).click();
    await openActions(page, "Move…");
    const dialog = page.getByRole("dialog", { name: "Move 1 copy" });
    await dialog
      .getByRole("searchbox", { name: "Search locations" })
      .fill(`0 Dest ${s}`);
    await dialog
      .getByRole("button", { name: `0 Dest ${s}`, exact: true })
      .click();
    await dialog.getByRole("button", { name: "Move 1 copy" }).click();
    return dialog;
  }

  test("a drag Move that fails keeps the selection, shows the error in the bar and leaves focus on Actions", async ({
    page,
  }) => {
    const { s, alpha, edition } = await seedAlphaAndDest(page, "Dragfail Abra");
    const row = (name: string) =>
      sidebar(page).getByRole("button", { name, exact: true });
    // Another tab adds a copy, so the dragged Holding's version is stale.
    await sql(
      `WITH changed AS (
         UPDATE inventory_owner SET revision=revision+1
         WHERE user_id=(SELECT owner_id FROM location WHERE id=$1) RETURNING revision
       ) UPDATE holding SET quantity=quantity+1,version=(SELECT revision FROM changed)
         WHERE location_id=$1 AND edition_id=$2`,
      [alpha, edition]
    );
    const from = await center(tiles(page).nth(0));
    const to = await center(row(`0 Dest ${s}`));
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 12 });
    await page.mouse.up();
    const alert = bar(page).getByRole("alert");
    await expect(alert).toContainText(`0 Alpha ${s}`);
    await expect(alert).toContainText("Nothing moved.");
    await expect(bar(page)).toContainText("1 copy selected");
    await expect(tiles(page)).toHaveCount(3);
    await expect(
      bar(page).getByRole("button", { name: "Actions" })
    ).toBeFocused();
  });

  test("a Move whose response is lost retries with the same manifest and key and applies once", async ({
    page,
  }) => {
    const { s } = await seedAlphaAndDest(page, "Lost Abra");
    const commits: { url: string; key: string }[] = [];
    let first = true;
    await page.route("**/api/moves/manifests/*/commit", async (route) => {
      const request = route.request();
      commits.push({
        url: request.url(),
        key: request.postDataJSON().idempotency_key,
      });
      if (first) {
        first = false;
        // The server applies the Move, but the collector never hears back.
        await route.fetch();
        await route.fulfill({ status: 503, body: "" });
        return;
      }
      await route.continue();
    });
    const dialog = await moveFirstTileToDest(page, s);
    await expect(dialog.getByRole("alert")).toContainText(
      "may not have finished"
    );
    await dialog.getByRole("button", { name: "Move 1 copy" }).click();
    await expect(toast(page)).toHaveText(`Moved 1 copy to 0 Dest ${s}.`);
    expect(commits).toHaveLength(2);
    expect(commits[1]).toEqual(commits[0]);
    await expectCounts(page, `0 Dest ${s}`, "1 copy · 1 edition");
    await expectCounts(page, `0 Alpha ${s}`, "1 copy · 1 edition");
  });

  /** Records each new manifest's id and each commit's URL and key; the first commit is refused with
   * `refusal`, later ones reach the server. */
  async function refuseFirstCommit(
    page: Page,
    refusal: { status: number; code: string }
  ) {
    const manifests: string[] = [];
    const commits: { url: string; key: string }[] = [];
    await page.route("**/api/moves/manifests", async (route) => {
      const response = await route.fetch();
      if (route.request().method() === "POST")
        manifests.push((await response.json()).id);
      await route.fulfill({ response });
    });
    await page.route("**/api/moves/manifests/*/commit", async (route) => {
      const request = route.request();
      commits.push({
        url: request.url(),
        key: request.postDataJSON().idempotency_key,
      });
      if (commits.length === 1) {
        await route.fulfill({
          status: refusal.status,
          contentType: "application/json",
          body: JSON.stringify({ detail: { code: refusal.code } }),
        });
        return;
      }
      await route.continue();
    });
    return { manifests, commits };
  }

  for (const refusal of [
    { status: 410, code: "MOVE_MANIFEST_EXPIRED", text: "took too long" },
    { status: 409, code: "UNEXPECTED_CONFLICT", text: "couldn't be completed" },
  ])
    test(`a definite failure (${refusal.status} ${refusal.code}) retries the same selection with a new manifest and a new key`, async ({
      page,
    }) => {
      const { s } = await seedAlphaAndDest(
        page,
        `Fresh ${refusal.status} Abra`
      );
      const { manifests, commits } = await refuseFirstCommit(page, refusal);
      const dialog = await moveFirstTileToDest(page, s);
      await expect(dialog.getByRole("alert")).toContainText(refusal.text);
      await expect(dialog.getByRole("alert")).toContainText("Nothing moved.");
      // The same selection to the same destination, straight from the dialog.
      await dialog.getByRole("button", { name: "Move 1 copy" }).click();
      await expect(toast(page)).toHaveText(`Moved 1 copy to 0 Dest ${s}.`);
      expect(manifests).toHaveLength(2);
      expect(commits).toHaveLength(2);
      expect(commits[0].url).toContain(manifests[0]);
      expect(commits[1].url).toContain(manifests[1]);
      expect(commits[1].key).not.toBe(commits[0].key);
      await expectCounts(page, `0 Dest ${s}`, "1 copy · 1 edition");
      await expectCounts(page, `0 Alpha ${s}`, "1 copy · 1 edition");
    });

  test("a failure whose refresh empties the selection moves to the toast without claiming the selection is kept", async ({
    page,
  }) => {
    const { s, alpha, edition } = await seedAlphaAndDest(page, "Zero Abra");
    await tiles(page).nth(0).click();
    await expect(bar(page)).toContainText("1 copy selected");
    // Another tab removes every copy of the selected Holding.
    await sql(
      `WITH changed AS (
         UPDATE inventory_owner SET revision=revision+1
         WHERE user_id=(SELECT owner_id FROM location WHERE id=$1) RETURNING revision
       ) DELETE FROM holding WHERE location_id=$1 AND edition_id=$2`,
      [alpha, edition]
    );
    await openActions(page, "Move…");
    const dialog = page.getByRole("dialog", { name: "Move 1 copy" });
    await dialog
      .getByRole("searchbox", { name: "Search locations" })
      .fill(`0 Dest ${s}`);
    await dialog
      .getByRole("button", { name: `0 Dest ${s}`, exact: true })
      .click();
    await dialog.getByRole("button", { name: "Move 1 copy" }).click();
    // The refresh finds nothing left to select: the dialog and bar go, the failure stays on screen.
    await expect(
      page.getByText("Your Collection has no cards yet.")
    ).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(bar(page)).toHaveCount(0);
    const notice = page
      .getByRole("status")
      .filter({ hasText: "Nothing moved." });
    await expect(notice).toHaveText(
      `Zero Abra (Fixture Set 1) in 0 Alpha ${s} changed since you selected it. Nothing moved. The cards have been refreshed.`
    );
    await expect(notice).not.toContainText("selection");
    expect(await focusedId(page)).toBe("ws-heading");
  });

  test("a drag failure whose refresh empties the selection moves to the toast and focuses the heading", async ({
    page,
  }) => {
    const { s, alpha, edition } = await seedAlphaAndDest(page, "Dragzero Abra");
    const row = sidebar(page).getByRole("button", {
      name: `0 Dest ${s}`,
      exact: true,
    });
    await tiles(page).nth(0).click();
    await expect(bar(page)).toContainText("1 copy selected");
    // Another tab removes every copy of the selected Holding.
    await sql(
      `WITH changed AS (
         UPDATE inventory_owner SET revision=revision+1
         WHERE user_id=(SELECT owner_id FROM location WHERE id=$1) RETURNING revision
       ) DELETE FROM holding WHERE location_id=$1 AND edition_id=$2`,
      [alpha, edition]
    );
    const from = await center(tiles(page).nth(0));
    const to = await center(row);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 12 });
    // As in browsers where a click doesn't focus a button: nothing on the bar holds focus when the failure lands.
    await page.evaluate(() =>
      (document.activeElement as HTMLElement | null)?.blur()
    );
    await page.mouse.up();
    // The refresh empties the selection: the bar and Actions unmount, the failure stays on screen.
    await expect(
      page.getByText("Your Collection has no cards yet.")
    ).toBeVisible();
    await expect(bar(page)).toHaveCount(0);
    const notice = page
      .getByRole("status")
      .filter({ hasText: "Nothing moved." });
    await expect(notice).toContainText("Nothing moved.");
    await expect(notice).not.toContainText("selection");
    expect(await focusedId(page)).toBe("ws-heading");
  });

  test("clearing the selection after a failure doesn't move the failure to the toast", async ({
    page,
  }) => {
    const { s, alpha, edition } = await seedAlphaAndDest(page, "Keep Abra");
    const row = sidebar(page).getByRole("button", {
      name: `0 Dest ${s}`,
      exact: true,
    });
    // Another tab adds a copy, so the dragged Holding's version is stale.
    await sql(
      `WITH changed AS (
         UPDATE inventory_owner SET revision=revision+1
         WHERE user_id=(SELECT owner_id FROM location WHERE id=$1) RETURNING revision
       ) UPDATE holding SET quantity=quantity+1,version=(SELECT revision FROM changed)
         WHERE location_id=$1 AND edition_id=$2`,
      [alpha, edition]
    );
    const from = await center(tiles(page).nth(0));
    const to = await center(row);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 12 });
    await page.mouse.up();
    await expect(bar(page).getByRole("alert")).toContainText("Nothing moved.");
    await expect(tiles(page)).toHaveCount(3);
    await expect(bar(page)).toContainText("1 copy selected");
    // Escape is the collector's own clear: the failure goes with the bar.
    await page.keyboard.press("Escape");
    await expect(bar(page)).toHaveCount(0);
    // A later action gives any effect of the clear time to render.
    await tiles(page).nth(0).click();
    await expect(bar(page)).toContainText("1 copy selected");
    await expect(
      page.getByRole("status").filter({ hasText: "Nothing moved." })
    ).toHaveCount(0);
  });

  test("Escape during a drag cancels it, keeps the selection and moves nothing", async ({
    page,
  }) => {
    const { s } = await seedAlphaAndDest(page, "Escape Abra");
    let commits = 0;
    await page.route("**/api/moves/manifests/*/commit", (route) => {
      commits += 1;
      return route.continue();
    });
    const row = sidebar(page).getByRole("button", {
      name: `0 Dest ${s}`,
      exact: true,
    });
    await tiles(page).nth(0).click();
    await tiles(page)
      .nth(1)
      .click({ modifiers: ["ControlOrMeta"] });
    await expect(bar(page)).toContainText("2 copies selected");
    // The heading shows the same counts; only the badge is hidden from assistive technology.
    const badge = page
      .getByText("2 copies · 1 edition", { exact: true })
      .and(page.locator('[aria-hidden="true"]'));
    const from = await center(tiles(page).nth(0));
    const to = await center(row);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 12 });
    await expect(badge).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(badge).toHaveCount(0);
    await page.mouse.up();
    await expect(bar(page)).toContainText("2 copies selected");
    await expect(pressed(page)).toHaveCount(2);
    await expect(toast(page)).toHaveCount(0);
    expect(commits).toBe(0);
    await expectCounts(page, `0 Dest ${s}`, "This Location has no cards.");
    await expectCounts(page, `0 Alpha ${s}`, "2 copies · 1 edition");
  });

  test("a keyboard-only Move: Space selects, Actions opens the explorer, and focus never falls to the page", async ({
    page,
  }) => {
    promoteCatalog({ "card-1": "Keys Abra" });
    await signIn(page);
    const s = randomUUID().slice(0, 8);
    const leaf = await createLocation(page, `Keys ${s}`, null);
    const shelf = await createLocation(page, `Shelf ${s}`, null);
    await createLocation(page, `Binder ${s}`, shelf);
    await addCopies(page, leaf, await editionOf("card-1"), 3);
    await page.reload();
    await expect(tiles(page)).toHaveCount(3);
    const actions = bar(page).getByRole("button", { name: "Actions" });

    // Clear selection from the keyboard: focus moves to the heading, not the page.
    await tiles(page).nth(0).focus();
    await page.keyboard.press("Space");
    await expect(bar(page)).toContainText("1 copy selected");
    for (
      let step = 0;
      step < 20 &&
      !(await actions.evaluate((e) => e === document.activeElement));
      step++
    )
      await page.keyboard.press("Tab");
    await expect(actions).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(actions).toHaveAttribute("aria-expanded", "true");
    // Escape closes the list only.
    await page.keyboard.press("Escape");
    await expect(actions).toHaveAttribute("aria-expanded", "false");
    await expect(actions).toBeFocused();
    await expect(bar(page)).toContainText("1 copy selected");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await expect(
      bar(page).getByRole("button", { name: "Clear selection" })
    ).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(bar(page)).toHaveCount(0);
    expect(await focusedId(page)).toBe("ws-heading");

    // Select two copies with Space, then Move through Actions.
    await tiles(page).nth(0).focus();
    await page.keyboard.press("Space");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Space");
    await expect(bar(page)).toContainText("2 copies selected");
    for (
      let step = 0;
      step < 20 &&
      !(await actions.evaluate((e) => e === document.activeElement));
      step++
    )
      await page.keyboard.press("Tab");
    await expect(actions).toBeFocused();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Tab");
    await expect(
      bar(page).getByRole("button", { name: "Move…" })
    ).toBeFocused();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Move 2 copies" });
    const search = dialog.getByRole("searchbox", { name: "Search locations" });
    await expect(search).toBeFocused();
    await page.keyboard.type(`Binder ${s}`);
    await page.keyboard.press("Tab");
    const match = dialog.getByRole("button", {
      name: `Shelf ${s} / Binder ${s}`,
      exact: true,
    });
    await expect(match).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(match).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await expect(
      dialog.getByRole("button", { name: "Move 2 copies" })
    ).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(toast(page)).toHaveText(
      `Moved 2 copies to Shelf ${s} / Binder ${s}.`
    );
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await focusedId(page)).toBe("ws-heading");
  });

  test("a Move to a destination deleted meanwhile keeps the selection and refreshes both views, with no stale banner", async ({
    page,
  }) => {
    const { s, dest } = await seedAlphaAndDest(page, "Gone Abra");
    await tiles(page).nth(0).click();
    await openActions(page, "Move…");
    const dialog = page.getByRole("dialog", { name: "Move 1 copy" });
    await dialog
      .getByRole("searchbox", { name: "Search locations" })
      .fill(`0 Dest ${s}`);
    await dialog
      .getByRole("button", { name: `0 Dest ${s}`, exact: true })
      .click();
    // Another session deletes the chosen destination before the collector confirms.
    const api = (path: string) => new URL(path, page.url()).href;
    const tree = await page.request.get(api("/api/location-tree"));
    const version = (
      (await tree.json()) as { locations: TreeNode[] }
    ).locations.find((node) => node.id === dest)!.version;
    const deleted = await page.request.delete(
      api(`/api/location-tree/${dest}`),
      {
        headers: { origin: new URL(page.url()).origin },
        data: { name: `0 Dest ${s}`, version, idempotency_key: randomUUID() },
      }
    );
    expect(deleted.status(), await deleted.text()).toBe(200);
    await dialog.getByRole("button", { name: "Move 1 copy" }).click();
    await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
      `0 Dest ${s} can no longer hold cards. Nothing moved.`
    );
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Cancel" })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    // The tree has caught up (Dest is gone) before the banner is checked, so the check isn't vacuous.
    await expect(
      sidebar(page).getByRole("button", { name: `0 Dest ${s}`, exact: true })
    ).toHaveCount(0);
    await expect(tiles(page)).toHaveCount(2);
    await expect(
      page.getByRole("status").filter({
        hasText: "Your collection changed in another tab or session.",
      })
    ).toHaveCount(0);
    await expect(bar(page)).toContainText("1 copy selected");
  });

  test("Undo is offered only for this tab's own record, never for another tab's same-shaped Move made just after it", async ({
    page,
  }) => {
    const { s, alpha, dest, edition } = await seedAlphaAndDest(
      page,
      "Race Abra"
    );
    // Between this tab's commit and its Undo list read, another tab moves the other copy the same way:
    // one source, the same destination, so the newest record has the same shape as this tab's.
    let raced = false;
    await page.route("**/api/moves/undo", async (route) => {
      if (!raced && route.request().method() === "GET") {
        raced = true;
        const api = (path: string) => new URL(path, page.url()).href;
        const headers = { origin: new URL(page.url()).origin };
        const pool = new Pool({ connectionString: process.env.DATABASE_URL });
        let version: number;
        try {
          version = (
            await pool.query(
              "SELECT version FROM holding WHERE location_id=$1 AND edition_id=$2",
              [alpha, edition]
            )
          ).rows[0].version;
        } finally {
          await pool.end();
        }
        const manifest = await (
          await page.request.post(api("/api/moves/manifests"), {
            headers,
            data: {},
          })
        ).json();
        const staged = await page.request.put(
          api(`/api/moves/manifests/${manifest.id}/items`),
          {
            headers,
            data: {
              items: [
                {
                  source_id: alpha,
                  edition_id: edition,
                  quantity: "1",
                  expected_version: Number(version),
                },
              ],
            },
          }
        );
        expect(staged.status(), await staged.text()).toBe(200);
        const committed = await page.request.post(
          api(`/api/moves/manifests/${manifest.id}/commit`),
          {
            headers,
            data: { destination_id: dest, idempotency_key: randomUUID() },
          }
        );
        expect(committed.status(), await committed.text()).toBe(200);
      }
      await route.continue();
    });
    const listed = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/moves/undo" &&
        response.request().method() === "GET"
    );
    await moveFirstTileToDest(page, s);
    await expect(toast(page)).toHaveText(`Moved 1 copy to 0 Dest ${s}.`);
    await listed;
    // Let the list's answer render before checking that no Undo was attached.
    await page.waitForTimeout(300);
    await expect(
      page.getByRole("button", { name: "Undo", exact: true })
    ).toHaveCount(0);
  });
});

test.describe("mobile", () => {
  test.use({
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
  });

  test("Move and Inventory Removal open as sheets, and the toast sits above the Actions strip", async ({
    page,
  }) => {
    promoteCatalog({ "card-1": "Pocket Abra" });
    await signIn(page);
    const s = randomUUID().slice(0, 8);
    const alpha = await createLocation(page, `Alpha ${s}`, null);
    await createLocation(page, `Dest ${s}`, null);
    await addCopies(page, alpha, await editionOf("card-1"), 3);
    await page.reload();
    await expect(tiles(page)).toHaveCount(3);
    await page.getByRole("button", { name: "Select", exact: true }).tap();
    await tiles(page).nth(0).tap();
    const strip = bar(page);
    await expect(strip).toContainText("1 copy selected");
    const actions = strip.getByRole("button", { name: "Actions" });
    await expectTouchTarget(actions, ["height"]);
    await actions.tap();
    const move = strip.getByRole("button", { name: "Move…" });
    await expectTouchTarget(move, ["height"]);
    await move.tap();

    // A sheet along the bottom edge, full width.
    const sheet = page.getByRole("dialog", { name: "Move 1 copy" });
    await expect(sheet).toBeVisible();
    const sheetBox = await box(sheet);
    expect(Math.round(sheetBox.y + sheetBox.height)).toBe(812);
    expect(Math.round(sheetBox.width)).toBe(375);
    await sheet
      .getByRole("searchbox", { name: "Search locations" })
      .fill(`Dest ${s}`);
    await sheet.getByRole("button", { name: `Dest ${s}`, exact: true }).tap();
    await sheet.getByRole("button", { name: "Move 1 copy" }).tap();
    await expect(toast(page)).toHaveText(`Moved 1 copy to Dest ${s}.`);
    await expect(strip).toHaveCount(0);

    // With a new selection, the toast sits above the strip.
    await expect(tiles(page)).toHaveCount(3);
    await tiles(page).nth(1).tap();
    await expect(strip).toContainText("1 copy selected");
    const undo = page.getByRole("button", { name: "Undo", exact: true });
    const toastBox = await expectTouchTarget(undo, ["height"]);
    const stripBox = await box(strip);
    expect(toastBox.y + toastBox.height).toBeLessThanOrEqual(stripBox.y);
    expect(stripBox.y + stripBox.height).toBeLessThanOrEqual(812);

    await strip.getByRole("button", { name: "Actions" }).tap();
    await strip.getByRole("button", { name: "Inventory Removal…" }).tap();
    const removal = page.getByRole("dialog", {
      name: "Remove 1 copy from your Collection",
    });
    await expect(removal).toBeVisible();
    const removalBox = await box(removal);
    expect(Math.round(removalBox.y + removalBox.height)).toBe(812);
    expect(Math.round(removalBox.width)).toBe(375);
    await removal.getByRole("button", { name: "Cancel" }).tap();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(strip).toContainText("1 copy selected");
  });
});
