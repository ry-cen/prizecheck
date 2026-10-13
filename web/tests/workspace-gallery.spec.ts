import { test, expect, type Page } from "@playwright/test";
import { signInAsOwner } from "./support/sign-in";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { startAsNewOwner } from "./support/owner";

type TreeNode = { id: string; name: string; version: number };

// A 1×1 PNG stands in for card artwork, so no test reaches the network and Names checks
// aren't confused by the no-image fallback (which shows the card name).
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
  await signInAsOwner(page, "/workspace");
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
const counts = (page: Page, text: string) =>
  page.getByRole("main").getByText(text, { exact: true });

/** Each tile's box, in DOM order. */
const boxes = (page: Page) =>
  tiles(page).evaluateAll((elements) =>
    elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        bottom: rect.bottom,
      };
    })
  );

async function tilesPerRow(page: Page) {
  const all = await boxes(page);
  return all.filter((box) => Math.abs(box.y - all[0].y) < 1).length;
}

const noHorizontalOverflow = (page: Page) =>
  page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth
  );

test("All owned shows one tile per copy with source captions; a Storage Leaf drops them", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  promoteCatalog({
    "card-1": "Gallery Abra",
    "card-2": "Gallery Pikachu",
    "card-3": "Gallery Zubat",
  });
  await signIn(page);
  const shelf = `Shelf ${randomUUID().slice(0, 8)}`;
  const shelfId = await createLocation(page, shelf, null);
  const binder10 = await createLocation(page, "Binder 10", shelfId);
  const binder2 = await createLocation(page, "Binder 2", shelfId);
  const box = await createLocation(page, "Box", shelfId);
  await createLocation(page, "Empty", shelfId);
  const [abra, pikachu, zubat] = await Promise.all(
    ["card-1", "card-2", "card-3"].map(editionOf)
  );
  await addCopies(page, binder2, pikachu, 2);
  await addCopies(page, binder10, pikachu, 1);
  await addCopies(page, binder10, abra, 1);
  await addCopies(page, box, zubat, 1);
  await page.reload();

  const heading = page.getByRole("heading", { level: 1 });
  await expect(heading).toHaveText("All owned");
  await expect(counts(page, "5 copies · 3 editions")).toBeVisible();
  await expect(tiles(page)).toHaveCount(5);
  // Card Edition order, then source Location path; one tile per copy, copies of an Edition together.
  const expected = [
    `Gallery Abra, Fixture Set 1, copy 1, ${shelf} / Binder 10`,
    `Gallery Pikachu, Fixture Set 2, copy 1, ${shelf} / Binder 10`,
    `Gallery Pikachu, Fixture Set 2, copy 1, ${shelf} / Binder 2`,
    `Gallery Pikachu, Fixture Set 2, copy 2, ${shelf} / Binder 2`,
    `Gallery Zubat, Fixture Set 3, copy 1, ${shelf} / Box`,
  ];
  for (const [index, label] of expected.entries())
    await expect(tiles(page).nth(index)).toHaveAccessibleName(label);
  // Displayed left to right, then top to bottom, in that order.
  const placed = await boxes(page);
  for (let index = 1; index < placed.length; index++)
    expect(
      placed[index].y > placed[index - 1].y ||
        (placed[index].y === placed[index - 1].y &&
          placed[index].x > placed[index - 1].x)
    ).toBe(true);
  const copy = tiles(page).nth(3);
  await expect(copy).toHaveAttribute(
    "title",
    `Gallery Pikachu · Fixture Set 2 · copy 2 · ${shelf} / Binder 2`
  );

  // All owned: the source caption shows even with Names off (the default).
  const names = page.getByRole("button", { name: "Names", exact: true });
  await expect(names).toHaveAttribute("aria-pressed", "false");
  await expect(copy).toContainText("Binder 2");
  await expect(copy).not.toContainText("Gallery Pikachu");
  await expect(copy).not.toContainText("Fixture Set");

  // Names on: the name, then set name and collector number on a second line.
  await names.click();
  await expect(names).toHaveAttribute("aria-pressed", "true");
  await expect(copy).toContainText("Gallery Pikachu");
  await expect(copy).toContainText("Fixture Set · 2");
  await expect(copy).toContainText("Binder 2");
  await names.click();
  await expect(copy).not.toContainText("Gallery Pikachu");

  // A Storage Leaf shows only its tiles, without captions; labels keep the full path.
  const nav = page
    .getByRole("complementary", { name: "Sidebar" })
    .getByRole("navigation", { name: "Locations" });
  await nav.getByRole("button", { name: shelf, exact: true }).click();
  await nav.getByRole("button", { name: "Binder 2", exact: true }).click();
  await expect(heading).toHaveText("Binder 2");
  await expect(counts(page, "2 copies · 1 edition")).toBeVisible();
  await expect(tiles(page)).toHaveCount(2);
  await expect(tiles(page).nth(1)).toHaveAccessibleName(
    `Gallery Pikachu, Fixture Set 2, copy 2, ${shelf} / Binder 2`
  );
  await expect(tiles(page).nth(1)).toHaveAttribute(
    "title",
    `Gallery Pikachu · Fixture Set 2 · copy 2 · ${shelf} / Binder 2`
  );
  await expect(tiles(page).nth(1)).not.toContainText("Binder 2");

  await nav.getByRole("button", { name: "Binder 10", exact: true }).click();
  await expect(counts(page, "2 copies · 2 editions")).toBeVisible();
  await nav.getByRole("button", { name: "Box", exact: true }).click();
  await expect(counts(page, "1 copy · 1 edition")).toBeVisible();
  await expect(tiles(page)).toHaveCount(1);
  await nav.getByRole("button", { name: "Empty", exact: true }).click();
  await expect(counts(page, "0 copies · 0 editions")).toBeVisible();
  await expect(
    cards(page).getByText("This Location has no cards.")
  ).toBeVisible();
  await expect(tiles(page)).toHaveCount(0);

  await nav.getByRole("button", { name: "All owned", exact: true }).click();
  await expect(counts(page, "5 copies · 3 editions")).toBeVisible();
  await expect(tiles(page)).toHaveCount(5);
});

test("tile sizes, cards per row and side padding follow the width", async ({
  page,
}) => {
  promoteCatalog({ "card-1": "Size Abra" });
  await page.setViewportSize({ width: 1280, height: 860 });
  await signIn(page);
  const leaf = await createLocation(
    page,
    `Sizes ${randomUUID().slice(0, 8)}`,
    null
  );
  await addCopies(page, leaf, await editionOf("card-1"), 40);
  await page.reload();
  await expect(tiles(page)).toHaveCount(40);

  const gutter = async () =>
    (await cards(page).boundingBox())!.x -
    (await page.getByRole("main").boundingBox())!.x;

  // 1280 px: 30 px side padding; small tiles at least 110 px wide.
  expect(await gutter()).toBeCloseTo(30, 0);
  const small1280 = await tilesPerRow(page);
  expect((await boxes(page))[0].width).toBeGreaterThanOrEqual(110);
  expect(await noHorizontalOverflow(page)).toBe(true);

  // Medium tiles are at least 145 px wide, so fewer fit in a row.
  await page.getByLabel("Card size").selectOption("medium");
  await expect
    .poll(async () => (await boxes(page))[0].width)
    .toBeGreaterThanOrEqual(145);
  await expect.poll(() => tilesPerRow(page)).toBeLessThan(small1280);
  await page.getByLabel("Card size").selectOption("small");
  await expect.poll(() => tilesPerRow(page)).toBe(small1280);

  // Wider screens: more cards per row, and side padding shrinks to 20 px, then 16 px.
  // The layout re-renders after a resize, so poll rather than read once.
  await page.setViewportSize({ width: 1600, height: 900 });
  await expect.poll(gutter).toBeCloseTo(20, 0);
  await expect.poll(() => tilesPerRow(page)).toBeGreaterThan(small1280);
  const small1600 = await tilesPerRow(page);
  expect(await noHorizontalOverflow(page)).toBe(true);
  await page.setViewportSize({ width: 2300, height: 1200 });
  await expect.poll(gutter).toBeCloseTo(16, 0);
  await expect.poll(() => tilesPerRow(page)).toBeGreaterThan(small1600);
  expect(await noHorizontalOverflow(page)).toBe(true);
});

test("card-shaped placeholders show until the first page arrives", async ({
  page,
}) => {
  promoteCatalog({ "card-1": "Slow Abra" });
  await page.setViewportSize({ width: 1280, height: 860 });
  await signIn(page);
  const leaf = await createLocation(
    page,
    `Slow ${randomUUID().slice(0, 8)}`,
    null
  );
  await addCopies(page, leaf, await editionOf("card-1"), 3);

  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(/\/api\/collection\/holdings/, async (route) => {
    await held;
    await route.continue();
  });
  await page.reload();
  const loading = page.getByRole("status", { name: "Loading cards" });
  await expect(loading).toBeVisible();
  await expect(tiles(page)).toHaveCount(0);
  await expect(page.getByRole("main").getByText(/copies ·/)).toHaveCount(0);
  const placeholder = await loading.locator(":scope > *").first().boundingBox();
  expect(placeholder!.height / placeholder!.width).toBeCloseTo(342 / 245, 1);

  release();
  await expect(loading).toBeHidden();
  await expect(tiles(page)).toHaveCount(3);
  await expect(counts(page, "3 copies · 1 edition")).toBeVisible();
});

/** The gallery grid's inline height, in px. */
const gridHeight = (page: Page) =>
  page.evaluate(() =>
    parseFloat(
      document.querySelector<HTMLElement>(".ws-gallery-grid")!.style.height ||
        "0"
    )
  );
/** The gallery grid's top edge in page coordinates. */
const gridTop = (page: Page) =>
  page.evaluate(
    () =>
      document.querySelector(".ws-gallery-grid")!.getBoundingClientRect().top +
      window.scrollY
  );

type GalleryRecord = { placeholders: number; heights: number[] };

/** From now on, counts every placeholder tile added to the page and records every height the gallery
 * grid is given. A style change's old value is recorded too, so a height that is replaced before the
 * observer runs is still seen. The whole page is watched, so a remounted gallery is caught as well. */
async function recordGallery(page: Page) {
  await page.evaluate(() => {
    const probe = document.createElement("div");
    const heightOf = (style: string | null) => {
      probe.setAttribute("style", style ?? "");
      return parseFloat(probe.style.height || "0");
    };
    const record = { placeholders: 0, heights: [] as number[] };
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        const target = mutation.target as HTMLElement;
        if (
          mutation.type === "attributes" &&
          target.classList.contains("ws-gallery-grid")
        )
          record.heights.push(
            heightOf(mutation.oldValue),
            parseFloat(target.style.height || "0")
          );
        for (const node of Array.from(mutation.addedNodes)) {
          if (!(node instanceof HTMLElement)) continue;
          if (
            node.matches(".ws-tile-placeholder") ||
            node.querySelector(".ws-tile-placeholder")
          )
            record.placeholders++;
          const grid = node.matches(".ws-gallery-grid")
            ? node
            : node.querySelector<HTMLElement>(".ws-gallery-grid");
          if (grid) record.heights.push(parseFloat(grid.style.height || "0"));
        }
      }
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["style"],
      attributeOldValue: true,
    });
    (window as unknown as { galleryRecord: typeof record }).galleryRecord =
      record;
  });
}
const galleryRecord = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { galleryRecord: GalleryRecord }).galleryRecord
  );
/** Two animation frames, so every commit after the last event has been painted. */
const settle = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );

/** Holds the listing requests for one Location until the returned release is called. Other
 * Locations' requests pass through. */
async function holdListing(page: Page, locationId: string) {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(/\/api\/collection\/holdings/, async (route) => {
    if (
      new URL(route.request().url()).searchParams.get("location_id") ===
      locationId
    )
      await held;
    await route.continue();
  });
  return release;
}
const listingFor = (page: Page, locationId: string) =>
  page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/collection/holdings" &&
      new URL(response.url()).searchParams.get("location_id") === locationId
  );

// Ticket 121: switching Locations must not flash placeholders or resize the gallery for a Location
// already shown. Tall holds more rows than the placeholders' one-viewport fill, so a gallery that
// reloads it from nothing changes height.
test("a Location shown before opens from its cached tiles while it is read again, with no placeholders or height change", async ({
  page,
}) => {
  promoteCatalog({ "card-1": "Revisit Abra", "card-2": "Revisit Zubat" });
  await page.setViewportSize({ width: 1280, height: 860 });
  await signIn(page);
  const s = randomUUID().slice(0, 8);
  const tall = await createLocation(page, `Tall ${s}`, null);
  const short = await createLocation(page, `Short ${s}`, null);
  await addCopies(page, tall, await editionOf("card-1"), 120);
  await addCopies(page, short, await editionOf("card-2"), 3);
  await page.reload();
  const nav = page
    .getByRole("complementary", { name: "Sidebar" })
    .getByRole("navigation", { name: "Locations" });

  await nav.getByRole("button", { name: `Tall ${s}`, exact: true }).click();
  await expect(counts(page, "120 copies · 1 edition")).toBeVisible();
  await expect(tiles(page).first()).toHaveAccessibleName(
    `Revisit Abra, Fixture Set 1, copy 1, Tall ${s}`
  );
  const tallHeight = await gridHeight(page);
  const tallTop = await gridTop(page);
  expect(tallHeight).toBeGreaterThan(1.5 * 860);
  await nav.getByRole("button", { name: `Short ${s}`, exact: true }).click();
  await expect(counts(page, "3 copies · 1 edition")).toBeVisible();
  await expect(tiles(page)).toHaveCount(3);
  const shortHeight = await gridHeight(page);
  // The heights the grid went through, each once: straight from Short's to Tall's, nothing between.
  const steps = (heights: number[]) =>
    heights.filter(
      (height, index) => index === 0 || height !== heights[index - 1]
    );

  // Tall's re-read is held: everything shown below comes from what was loaded before.
  const release = await holdListing(page, tall);
  const reread = page.waitForRequest(
    (request) =>
      new URL(request.url()).pathname === "/api/collection/holdings" &&
      new URL(request.url()).searchParams.get("location_id") === tall
  );
  await recordGallery(page);
  await nav.getByRole("button", { name: `Tall ${s}`, exact: true }).click();
  await reread;
  await settle(page);
  let record = await galleryRecord(page);
  expect(record.placeholders).toBe(0);
  expect(steps(record.heights)).toEqual([shortHeight, tallHeight]);
  await expect(counts(page, "120 copies · 1 edition")).toBeVisible();
  await expect(tiles(page).first()).toHaveAccessibleName(
    `Revisit Abra, Fixture Set 1, copy 1, Tall ${s}`
  );
  expect(await gridHeight(page)).toBe(tallHeight);
  expect(await gridTop(page)).toBe(tallTop);

  // The re-read lands without changing anything on screen.
  const landed = listingFor(page, tall);
  release();
  await landed;
  await settle(page);
  record = await galleryRecord(page);
  expect(record.placeholders).toBe(0);
  expect(steps(record.heights)).toEqual([shortHeight, tallHeight]);
  await expect(counts(page, "120 copies · 1 edition")).toBeVisible();
  expect(await gridHeight(page)).toBe(tallHeight);
});

test("a Location changed elsewhere since it was shown opens from its cached tiles, then takes the re-read's result", async ({
  page,
}) => {
  promoteCatalog({ "card-1": "Revisit Abra", "card-2": "Revisit Zubat" });
  await page.setViewportSize({ width: 1280, height: 860 });
  await signIn(page);
  const s = randomUUID().slice(0, 8);
  const tall = await createLocation(page, `Tall ${s}`, null);
  const short = await createLocation(page, `Short ${s}`, null);
  const abra = await editionOf("card-1");
  await addCopies(page, tall, abra, 120);
  await addCopies(page, short, await editionOf("card-2"), 3);
  await page.reload();
  const nav = page
    .getByRole("complementary", { name: "Sidebar" })
    .getByRole("navigation", { name: "Locations" });

  await nav.getByRole("button", { name: `Tall ${s}`, exact: true }).click();
  await expect(counts(page, "120 copies · 1 edition")).toBeVisible();
  await nav.getByRole("button", { name: `Short ${s}`, exact: true }).click();
  await expect(counts(page, "3 copies · 1 edition")).toBeVisible();

  // A copy added outside the gallery while Tall is not shown; Tall's re-read is held.
  await addCopies(page, tall, abra, 1);
  const release = await holdListing(page, tall);
  const reread = page.waitForRequest(
    (request) =>
      new URL(request.url()).pathname === "/api/collection/holdings" &&
      new URL(request.url()).searchParams.get("location_id") === tall
  );
  await recordGallery(page);
  await nav.getByRole("button", { name: `Tall ${s}`, exact: true }).click();
  await reread;
  await settle(page);
  // Until the re-read is complete, the cached tiles stay, with no placeholders.
  expect((await galleryRecord(page)).placeholders).toBe(0);
  await expect(counts(page, "120 copies · 1 edition")).toBeVisible();

  // The completed re-read replaces them.
  const landed = listingFor(page, tall);
  release();
  await landed;
  await expect(counts(page, "121 copies · 1 edition")).toBeVisible();
  expect((await galleryRecord(page)).placeholders).toBe(0);
});

test("a Location not shown before keeps the gallery's height while its first page loads, then takes its own", async ({
  page,
}) => {
  promoteCatalog({ "card-1": "Revisit Abra", "card-2": "Revisit Zubat" });
  await page.setViewportSize({ width: 1280, height: 860 });
  await signIn(page);
  const s = randomUUID().slice(0, 8);
  const tall = await createLocation(page, `Tall ${s}`, null);
  const short = await createLocation(page, `Short ${s}`, null);
  await addCopies(page, tall, await editionOf("card-1"), 120);
  await addCopies(page, short, await editionOf("card-2"), 3);
  await page.reload();
  const nav = page
    .getByRole("complementary", { name: "Sidebar" })
    .getByRole("navigation", { name: "Locations" });

  await nav.getByRole("button", { name: `Tall ${s}`, exact: true }).click();
  await expect(counts(page, "120 copies · 1 edition")).toBeVisible();
  const tallHeight = await gridHeight(page);
  expect(tallHeight).toBeGreaterThan(1.5 * 860);

  const topBefore = await gridTop(page);
  const release = await holdListing(page, short);
  await recordGallery(page);
  await nav.getByRole("button", { name: `Short ${s}`, exact: true }).click();
  // Short was never listed, so its placeholders show; the grid keeps Tall's height meanwhile.
  await expect(
    page.getByRole("status", { name: "Loading cards" })
  ).toBeVisible();
  await settle(page);
  let record = await galleryRecord(page);
  for (const height of record.heights)
    expect(height).toBeGreaterThanOrEqual(tallHeight);
  expect(await gridHeight(page)).toBeGreaterThanOrEqual(tallHeight);
  expect(await gridTop(page)).toBe(topBefore);

  // Short's first page sizes the grid to Short's three tiles, once.
  const landed = listingFor(page, short);
  release();
  await landed;
  await expect(counts(page, "3 copies · 1 edition")).toBeVisible();
  await expect(tiles(page)).toHaveCount(3);
  const shortHeight = await gridHeight(page);
  expect(shortHeight).toBeLessThan(tallHeight);
  expect(shortHeight).toBeGreaterThan(0);
  record = await galleryRecord(page);
  for (const height of record.heights)
    expect([tallHeight, shortHeight]).toContain(height);
});

// @slow (capacity): seeds 25,000 Holdings and walks all 50 pages of the listing.
test(
  "a 25,000-Holding Collection mounts only the tiles near the viewport",
  { tag: "@slow" },
  async ({ page }) => {
    test.setTimeout(180_000);
    promoteCatalog({ "card-1": "Bulk Pikachu" });
    await page.setViewportSize({ width: 1600, height: 900 });
    await signIn(page);
    const leaf = await createLocation(
      page,
      `Bulk ${randomUUID().slice(0, 8)}`,
      null
    );
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
      const owner = (
        await pool.query('SELECT id FROM "user" WHERE email=$1', [
          process.env.OWNER_EMAIL || "owner@example.test",
        ])
      ).rows[0].id;
      const printing = (
        await pool.query(
          "SELECT id FROM catalog_printing WHERE source_id='card-1'"
        )
      ).rows[0].id;
      await pool.query(
        `INSERT INTO catalog_edition(printing_id,descriptor_key,descriptor)
         SELECT $1,'bulk-'||n,'{}'::jsonb FROM generate_series(1,25000) n`,
        [printing]
      );
      await pool.query(
        `INSERT INTO holding(owner_id,location_id,edition_id,quantity,version)
         SELECT $1,$2,id,1,1 FROM catalog_edition WHERE printing_id=$3 AND descriptor_key LIKE 'bulk-%'`,
        [owner, leaf, printing]
      );
    } finally {
      await pool.end();
    }
    await page.reload();
    await expect(counts(page, "25,000 copies · 25,000 editions")).toBeVisible({
      timeout: 30_000,
    });
    await expect(tiles(page)).not.toHaveCount(0);
    // flake-exempt one-shot-read (invariant): at no moment may the gallery mount more than 400 tiles.
    expect(await tiles(page).count()).toBeLessThanOrEqual(400);

    // The middle of the gallery mounts real tiles, still a bounded number.
    await page.evaluate(() =>
      window.scrollTo(0, document.documentElement.scrollHeight / 2)
    );
    await expect
      .poll(
        () =>
          tiles(page).evaluateAll((elements) =>
            elements.some((element) => {
              const rect = element.getBoundingClientRect();
              return rect.bottom > 0 && rect.top < window.innerHeight;
            })
          ),
        { timeout: 90_000 }
      )
      .toBe(true);
    // flake-exempt one-shot-read (invariant): at no moment may the gallery mount more than 400 tiles.
    expect(await tiles(page).count()).toBeLessThanOrEqual(400);

    // The end: once every page has loaded, the last row holds real tiles, flush with the gallery's end.
    await page.evaluate(() =>
      window.scrollTo(0, document.documentElement.scrollHeight)
    );
    await expect
      .poll(
        async () => {
          const end = (await cards(page).boundingBox())!;
          const lowest = Math.max(
            ...(await boxes(page)).map((box) => box.bottom)
          );
          return Math.abs(end.y + end.height - lowest) < 1;
        },
        { timeout: 90_000 }
      )
      .toBe(true);
    // flake-exempt one-shot-read (invariant): at no moment may the gallery mount more than 400 tiles.
    expect(await tiles(page).count()).toBeLessThanOrEqual(400);
  }
);

test.describe("mobile", () => {
  test.use({
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
  });

  test("mobile gallery shows tiles with captions and no horizontal overflow", async ({
    page,
  }) => {
    promoteCatalog({ "card-1": "Pocket Abra" });
    await signIn(page);
    const leaf = await createLocation(
      page,
      `Pocket ${randomUUID().slice(0, 8)}`,
      null
    );
    await addCopies(page, leaf, await editionOf("card-1"), 7);
    await page.reload();
    await expect(tiles(page)).toHaveCount(7);
    await expect(counts(page, "7 copies · 1 edition")).toBeVisible();
    await expect(tiles(page).first()).toContainText(/^Pocket /);
    expect(await tilesPerRow(page)).toBeGreaterThanOrEqual(3);
    expect(await noHorizontalOverflow(page)).toBe(true);
  });
});
