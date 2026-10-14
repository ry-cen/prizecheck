import { test, expect, type Page } from "@playwright/test";
import { signInAsOwner } from "./support/sign-in";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { expectPageChecks } from "./support/page-check";
import { startAsNewOwner } from "./support/owner";

// #166: Collection's sidebar and Location tree, toolbar, filters and display settings, the stale banner, the
// Reviewed Edition corrections, the Deck heading, Add cards and Manage locations are on the kit. Each state
// passes the shared page check at 1280×800 and 375×812, with its dialogs, drawers and menus open as well as
// closed. Helpers follow workspace-accessibility.spec.ts.

type TreeNode = { id: string; name: string; version: number };

// A 1×1 PNG stands in for card artwork, so no test reaches the network.
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64"
);

/** Replaces the catalog with one Printing per name (set "Fixture Set", number from the id), each with
 * artwork. This also clears every Holding. */
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
  await page.route(/^https:\/\/assets\.tcgdex\.net\//, (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: PIXEL })
  );
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

async function createDeck(page: Page, name: string): Promise<string> {
  const response = await page.request.post(
    new URL("/api/decks", page.url()).href,
    {
      headers: { origin: new URL(page.url()).origin },
      data: { name, idempotency_key: randomUUID() },
    }
  );
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

type World = {
  shelf: string;
  binder: string;
  deck: string;
  binderId: string;
  abra: string;
};

/** A folder with a Storage Leaf, a Deck, copies in both, and a reviewed correction for the Edition (stubbed:
 * the review pipeline is covered by catalog-reconciliation.spec.ts). */
async function seed(page: Page): Promise<World> {
  promoteCatalog({ "card-1": "Check Abra" });
  await signIn(page);
  const s = randomUUID().slice(0, 8);
  const shelf = `0 Shelf ${s}`;
  const deck = `0 Deck ${s}`;
  const shelfId = await createLocation(page, shelf, null);
  const binderId = await createLocation(page, "Binder", shelfId);
  const deckId = await createDeck(page, deck);
  const abra = await editionOf("card-1");
  await addCopies(page, binderId, abra, 2);
  await addCopies(page, deckId, abra, 1);
  await page.route("**/api/catalog/edition-replacements", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        {
          edition_id: abra,
          replacement_edition_id: randomUUID(),
          evidence_url: "https://example.org/evidence",
          reason: "Fixture correction.",
        },
      ]),
    })
  );
  await page.reload();
  await expect(tiles(page)).toHaveCount(3);
  return { shelf, binder: `${shelf} / Binder`, deck, binderId, abra };
}

const tiles = (page: Page) =>
  page.getByRole("region", { name: "Cards" }).getByRole("button");
const heading = (page: Page) => page.getByRole("heading", { level: 1 });
const corrections = (page: Page) =>
  page.getByRole("region", { name: "Reviewed Edition corrections" });
const manage = (page: Page) =>
  page.getByRole("dialog", { name: "Manage locations", exact: true });

/** Checks the open Deck's banner (#181): its cost and the link to the deck builder; exports live on Decks now. */
async function checkDeckHeading(page: Page, width: string) {
  const banner = page.getByRole("region", { name: "Deck banner" });
  await expect(
    banner.getByRole("region", { name: "Estimated Deck Cost" })
  ).toBeVisible();
  await expect(
    banner.getByRole("link", { name: "Open in the deck builder" })
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Export", exact: true })
  ).toHaveCount(0);
  await expectPageChecks(page, `Deck banner (${width})`);
}

/** Opens Add cards (#175: Catalog's gallery in Add mode) for the open Location, searches, checks it with a card
 * queued, and closes it. */
async function checkAddCards(page: Page, path: string, width: string) {
  await page.getByRole("button", { name: "Add cards", exact: true }).click();
  const add = page.getByRole("dialog", { name: `Add cards to ${path}` });
  await expect(add).toBeVisible();
  await add
    .getByRole("searchbox", { name: "Search the catalog" })
    .fill("Check");
  await add
    .getByRole("region", { name: "Catalog results" })
    .getByRole("button", {
      name: "One more Check Abra fixture 1 Normal",
      exact: true,
    })
    .click();
  await expect(
    add.getByRole("region", { name: "Add to a Location" })
  ).toContainText("1× Check Abra");
  await expectPageChecks(page, `Add cards (${width})`);
  await add.getByRole("button", { name: "Close Add cards" }).click();
  await expect(add).toHaveCount(0);
}

/** Checks Manage locations on its list, its Rename step and its Move picker, then closes it with Escape. */
async function checkManage(page: Page, world: World, width: string) {
  const panel = manage(page);
  await expect(panel).toBeVisible();
  await expect(
    panel.getByRole("group", { name: world.binder, exact: true })
  ).toBeVisible();
  await expectPageChecks(page, `Manage locations (${width})`);
  await panel
    .getByRole("button", { name: `Rename ${world.binder}`, exact: true })
    .click();
  await expect(panel.getByLabel("New name")).toBeFocused();
  await expectPageChecks(page, `Manage locations Rename (${width})`);
  await panel.getByRole("button", { name: "Cancel", exact: true }).click();
  await panel
    .getByRole("button", { name: `Move ${world.binder}`, exact: true })
    .click();
  await expect(
    panel.getByRole("list", { name: "New parent", exact: true })
  ).toBeVisible();
  await expectPageChecks(page, `Manage locations Move picker (${width})`);
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
}

/** Another session adds a copy; focusing the window shows the stale banner, which is checked. */
async function checkStaleBanner(page: Page, world: World, width: string) {
  await addCopies(page, world.binderId, world.abra, 1);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(
    page.getByRole("button", { name: "Reload", exact: true })
  ).toBeVisible();
  await expectPageChecks(page, `stale banner (${width})`);
}

test.describe("at 1280×800", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("the sidebar, toolbar, filters, corrections, Deck heading, Add cards, Manage locations and the stale banner pass the page check", async ({
    page,
  }) => {
    const world = await seed(page);
    const sidebar = page.getByRole("complementary", { name: "Sidebar" });
    const nav = sidebar.getByRole("navigation", { name: "Locations" });

    // All owned: the sidebar and its tree, the toolbar and the corrections above the gallery.
    await expect(corrections(page)).toBeVisible();
    await nav.getByRole("button", { name: world.shelf, exact: true }).click();
    await expect(
      nav.getByRole("button", { name: "Binder", exact: true })
    ).toBeVisible();
    await expectPageChecks(page, "All owned with the tree open (1280)");

    // Names, Prices and the filter panel.
    await page.getByRole("button", { name: "Names", exact: true }).click();
    await page.getByRole("button", { name: "Prices", exact: true }).click();
    await page.getByRole("button", { name: /^Filters/ }).click();
    await expect(
      page.getByRole("region", { name: "Card filters" })
    ).toBeVisible();
    await expectPageChecks(page, "filter panel, Names and Prices (1280)");

    // A Storage Leaf, and Add cards over it.
    await nav.getByRole("button", { name: "Binder", exact: true }).click();
    await expect(heading(page)).toHaveText("Binder");
    await checkAddCards(page, world.binder, "1280");

    // Manage locations from the sidebar gear: its list, Rename and the Move picker.
    await sidebar
      .getByRole("button", { name: "Manage locations", exact: true })
      .click();
    await checkManage(page, world, "1280");

    // The Deck heading, its Export menu and an export panel.
    await nav.getByRole("button", { name: world.deck, exact: true }).click();
    await expect(heading(page)).toHaveText(world.deck);
    await checkDeckHeading(page, "1280");

    await checkStaleBanner(page, world, "1280");
  });
});

test.describe("at 375×812", () => {
  test.use({
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
  });

  test("the phone header, the Locations drawer, Filters & display, Manage locations, the Deck heading, Add cards and the stale banner pass the page check", async ({
    page,
  }) => {
    const world = await seed(page);
    const opener = page
      .getByRole("banner")
      .getByRole("button", { name: "Open locations" });
    const drawer = page.getByRole("dialog", { name: "Locations", exact: true });
    const nav = drawer.getByRole("navigation", { name: "Locations" });

    // All owned under the phone header, with the corrections above the gallery.
    await expect(corrections(page)).toBeVisible();
    await expectPageChecks(page, "All owned (375)");

    // The Locations drawer with the folder open.
    await opener.click();
    await expect(drawer).toBeVisible();
    await nav.getByRole("button", { name: world.shelf, exact: true }).click();
    await expect(
      nav.getByRole("button", { name: "Binder", exact: true })
    ).toBeVisible();
    await expectPageChecks(page, "Locations drawer (375)");

    // Manage locations from the drawer's gear: the whole screen.
    await drawer
      .getByRole("button", { name: "Manage locations", exact: true })
      .click();
    await checkManage(page, world, "375");
    await expect(opener).toBeFocused();

    // Filters & display along the right edge.
    await page.getByRole("button", { name: /^Filters & display/ }).click();
    const filters = page.getByRole("dialog", { name: "Filters & display" });
    await expect(filters).toBeVisible();
    await expectPageChecks(page, "Filters & display (375)");
    await page.keyboard.press("Escape");
    await expect(filters).toHaveCount(0);

    // The Deck heading, its Export menu and an export panel.
    await opener.click();
    await nav.getByRole("button", { name: world.deck, exact: true }).click();
    await expect(heading(page)).toHaveText(world.deck);
    await checkDeckHeading(page, "375");

    // A Storage Leaf, and Add cards over it. The folder is still open from before.
    await opener.click();
    await nav.getByRole("button", { name: "Binder", exact: true }).click();
    await expect(heading(page)).toHaveText("Binder");
    await checkAddCards(page, world.binder, "375");

    await checkStaleBanner(page, world, "375");
  });
});
