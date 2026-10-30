import { expect, type Locator, type Page } from "@playwright/test";
import { signInAsOwner } from "./support/sign-in";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { expectPageChecks } from "./support/page-check";
import { startAsNewOwner } from "./support/owner";
import { test, artUpstream } from "./support/art-upstream";

// #164: every Card Edition in Collection names its Variant Descriptor (tiles, accessible names, the
// inspector), and the inspector lists each Storage Leaf that holds the Edition. Helpers follow
// workspace-selection.spec.ts.

type TreeNode = { id: string; name: string; version: number };

const OWNER_EMAIL = process.env.OWNER_EMAIL || "owner@example.test";

// Card artwork comes through the art route (/api/art/{printing}/{small|large}); the API's fetcher reads the stub of
// support/art-upstream.ts (a 1×1 PNG), so no test reaches the network.
const ART_SMALL = /^\/api\/art\/[0-9a-f-]{36}\/small\?v=[0-9a-f]{8}$/;
const ART_LARGE = /^\/api\/art\/[0-9a-f-]{36}\/large\?v=[0-9a-f]{8}$/;

/** A Variant Descriptor too long for a tile's Names line. */
const LONG_VARIANT =
  "Reverse Holo, Poké Ball pattern, Prerelease stamp, Jumbo oversized";

/** Replaces the catalog with one Printing per name (set "Fixture Set", number from the id), each with
 * artwork. card-1 gets a normal and a reverse Edition, every other card a normal one. This also clears
 * every Holding. */
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

type Editions = {
  normal: string;
  reverse: string;
  unspecified: string;
  long: string;
};

/** card-1's normal and reverse Editions, plus two Editions of card-2 stored by SQL with the
 * descriptors the catalog writes for an Unspecified Variant and for a reviewed label. */
async function editions(): Promise<Editions> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const of = async (sourceId: string, finish: string) =>
      (
        await pool.query(
          `SELECT e.id FROM catalog_edition e JOIN catalog_printing p ON p.id=e.printing_id
           WHERE p.source_id=$1 AND e.descriptor->>'finish'=$2`,
          [sourceId, finish]
        )
      ).rows[0].id as string;
    const printing = (
      await pool.query(
        "SELECT id FROM catalog_printing WHERE source_id='card-2'"
      )
    ).rows[0].id as string;
    const add = async (key: string, descriptor: object) =>
      (
        await pool.query(
          `INSERT INTO catalog_edition(printing_id,descriptor_key,descriptor) VALUES($1,$2,$3) RETURNING id`,
          [printing, key, JSON.stringify(descriptor)]
        )
      ).rows[0].id as string;
    return {
      normal: await of("card-1", "normal"),
      reverse: await of("card-1", "reverse"),
      unspecified: await add("variant-unspecified", {
        kind: "unspecified",
        label: "Unspecified Variant",
      }),
      long: await add("variant-long", { label: LONG_VARIANT }),
    };
  } finally {
    await pool.end();
  }
}

/** Stores copies by SQL, then moves the owner revision once, as workspace-prices.spec.ts does. */
async function hold(
  rows: { location: string; edition: string; quantity: number }[]
) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const owner = (
      await pool.query('SELECT id FROM "user" WHERE email=$1', [OWNER_EMAIL])
    ).rows[0].id as string;
    for (const row of rows)
      await pool.query(
        "INSERT INTO holding(owner_id,location_id,edition_id,quantity,version) VALUES($1,$2,$3,$4,1)",
        [owner, row.location, row.edition, row.quantity]
      );
    await pool.query(
      "UPDATE inventory_owner SET revision=revision+1 WHERE user_id=$1",
      [owner]
    );
  } finally {
    await pool.end();
  }
}

const cards = (page: Page) => page.getByRole("region", { name: "Cards" });
const tiles = (page: Page) => cards(page).getByRole("button");
const tile = (page: Page, name: string) =>
  cards(page).getByRole("button", { name, exact: true });
const inspector = (page: Page) =>
  page.getByRole("complementary", { name: "Card details" });
const leaves = (scope: Locator) =>
  scope.getByRole("list", { name: "Copies by location" }).getByRole("listitem");

async function height(locator: Locator) {
  const found = await locator.boundingBox();
  expect(found).not.toBeNull();
  return found!.height;
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("every tile names its Variant; with Names on the Names line shows it after set and number, and no tile changes height", async ({
    page,
  }) => {
    promoteCatalog({ "card-1": "Variant Abra", "card-2": "Variant Pikachu" });
    await signIn(page);
    const leaf = `Binder ${randomUUID().slice(0, 8)}`;
    const id = await createLocation(page, leaf, null);
    const ids = await editions();
    await hold([
      { location: id, edition: ids.normal, quantity: 1 },
      { location: id, edition: ids.reverse, quantity: 1 },
      { location: id, edition: ids.unspecified, quantity: 1 },
      { location: id, edition: ids.long, quantity: 1 },
    ]);
    await page.reload();
    await expect(tiles(page)).toHaveCount(4);

    // The accessible name and hover title carry the Variant whether or not Names is on.
    const normal = tile(
      page,
      `Variant Abra, Fixture Set 1, Normal, copy 1, ${leaf}`
    );
    const reverse = tile(
      page,
      `Variant Abra, Fixture Set 1, Reverse Holo, copy 1, ${leaf}`
    );
    const unspecified = tile(
      page,
      `Variant Pikachu, Fixture Set 2, Unspecified Variant, copy 1, ${leaf}`
    );
    const long = tile(
      page,
      `Variant Pikachu, Fixture Set 2, ${LONG_VARIANT}, copy 1, ${leaf}`
    );
    for (const found of [normal, reverse, unspecified, long])
      await expect(found).toHaveCount(1);
    await expect(reverse).toHaveAttribute(
      "title",
      `Variant Abra · Fixture Set 1 · Reverse Holo · copy 1 · ${leaf}`
    );
    await expect(unspecified).toHaveAttribute(
      "title",
      `Variant Pikachu · Fixture Set 2 · Unspecified Variant · copy 1 · ${leaf}`
    );

    // Names off (the default): the Variant isn't drawn.
    const names = page.getByRole("button", { name: "Names", exact: true });
    await expect(names).toHaveAttribute("aria-pressed", "false");
    await expect(reverse).not.toContainText("Reverse Holo");
    const off = await Promise.all(
      [normal, reverse, unspecified, long].map(height)
    );

    // Names on: "Set · Number · Variant" on the second line, cut with an ellipsis when too long.
    await names.click();
    await expect(names).toHaveAttribute("aria-pressed", "true");
    await expect(normal).toContainText("fixture · 1 · Normal");
    await expect(reverse).toContainText("fixture · 1 · Reverse Holo");
    await expect(unspecified).toContainText(
      "fixture · 2 · Unspecified Variant"
    );
    const line = long.getByText(`fixture · 2 · ${LONG_VARIANT}`, {
      exact: true,
    });
    expect(
      await line.evaluate((element) => ({
        cut: element.scrollWidth > element.clientWidth,
        ellipsis: getComputedStyle(element).textOverflow,
        oneLine: getComputedStyle(element).whiteSpace,
      }))
    ).toEqual({ cut: true, ellipsis: "ellipsis", oneLine: "nowrap" });
    // Every tile grows by the same Names line, however long its Variant.
    const on = await Promise.all(
      [normal, reverse, unspecified, long].map(height)
    );
    for (const [index, value] of on.entries())
      expect(value - off[index]).toBeCloseTo(34, 0);
    expect(new Set(on.map(Math.round)).size).toBe(1);
    await expectPageChecks(page, "Collection with Names on");

    await names.click();
    await expect(reverse).not.toContainText("Reverse Holo");
    expect(await height(long)).toBeCloseTo(off[3], 0);
  });

  test("the inspector shows the Variant row and each Storage Leaf that holds the Edition, with its quantity and path", async ({
    page,
  }) => {
    promoteCatalog({ "card-1": "Spread Abra", "card-2": "Spread Pikachu" });
    await signIn(page);
    const s = randomUUID().slice(0, 8);
    const shelf = await createLocation(page, `Shelf ${s}`, null);
    const binder = await createLocation(page, "Binder", shelf);
    const box = await createLocation(page, "Box", shelf);
    const alpha = await createLocation(page, `Alpha ${s}`, null);
    const ids = await editions();
    await hold([
      { location: binder, edition: ids.normal, quantity: 2 },
      { location: box, edition: ids.normal, quantity: 3 },
      { location: alpha, edition: ids.normal, quantity: 1 },
      { location: box, edition: ids.unspecified, quantity: 1 },
    ]);
    await page.reload();
    await expect(tiles(page)).toHaveCount(7);

    // A selected copy in Binder: its Variant, then every Leaf holding the Edition, in path order.
    await tile(
      page,
      `Spread Abra, Fixture Set 1, Normal, copy 1, Shelf ${s} / Binder`
    ).click();
    const panel = inspector(page);
    await expect(
      panel.getByRole("heading", { name: "Spread Abra" })
    ).toBeVisible();
    await expect(panel).toContainText("fixture · 1");
    await expect(panel).toContainText(/Variant\s*Normal/);
    await expect(panel).toContainText("2 copies here");
    await expect(panel).toContainText("6 copies owned");
    await expect(leaves(panel)).toHaveText([
      `1 in Alpha ${s}`,
      `2 in Shelf ${s} / Binder`,
      `3 in Shelf ${s} / Box`,
    ]);
    await expectPageChecks(page, "Collection with the inspector");

    // The Unspecified Variant Edition, held in one Leaf.
    await tile(
      page,
      `Spread Pikachu, Fixture Set 2, Unspecified Variant, copy 1, Shelf ${s} / Box`
    ).click();
    await expect(panel).toContainText(/Variant\s*Unspecified Variant/);
    await expect(panel).toContainText("1 copy owned");
    await expect(leaves(panel)).toHaveText([`1 in Shelf ${s} / Box`]);

    // Selecting another card shows its breakdown.
    await page.keyboard.press("Escape");
    await tile(
      page,
      `Spread Abra, Fixture Set 1, Normal, copy 1, Alpha ${s}`
    ).click();
    await expect(panel).toContainText("1 copy here");
    await expect(leaves(panel)).toHaveCount(3);
  });

  test("the inspector shows a card's large artwork, and its small artwork when the large one fails", async ({
    page,
  }) => {
    promoteCatalog({ "card-1": "Art Abra", "card-2": "Art Pikachu" });
    await signIn(page);
    const upstream = await artUpstream();
    const s = randomUUID().slice(0, 8);
    const leaf = await createLocation(page, `Art ${s}`, null);
    const ids = await editions();
    await hold([
      { location: leaf, edition: ids.normal, quantity: 1 },
      { location: leaf, edition: ids.unspecified, quantity: 1 },
    ]);
    await page.reload();
    const art = inspector(page).locator("img");

    await tile(
      page,
      `Art Abra, Fixture Set 1, Normal, copy 1, Art ${s}`
    ).click();
    await expect(art).toHaveAttribute("src", ART_LARGE);
    await expect
      .poll(() => upstream.requests)
      .toContain("/en/fixture/card-1/high.webp");

    // The art host has no large file for card-2: the route answers 404 and the inspector shows the small one.
    upstream.missing.add("/en/fixture/card-2/high.webp");
    await tile(
      page,
      `Art Pikachu, Fixture Set 2, Unspecified Variant, copy 1, Art ${s}`
    ).click();
    await expect(art).toHaveAttribute("src", ART_SMALL);

    // Another card starts again from its large artwork.
    await tile(
      page,
      `Art Abra, Fixture Set 1, Normal, copy 1, Art ${s}`
    ).click();
    await expect(art).toHaveAttribute("src", ART_LARGE);
  });
});

test.describe("phone", () => {
  test.use({
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
  });

  test("the details sheet shows the Variant and every copy's Location, and Collection passes the page check with it open and closed", async ({
    page,
  }) => {
    promoteCatalog({ "card-1": "Sheet Abra", "card-2": "Sheet Pikachu" });
    await signIn(page);
    const s = randomUUID().slice(0, 8);
    const alpha = await createLocation(page, `Alpha ${s}`, null);
    const beta = await createLocation(page, `Beta ${s}`, null);
    const ids = await editions();
    await hold([
      { location: alpha, edition: ids.reverse, quantity: 2 },
      { location: beta, edition: ids.reverse, quantity: 1 },
    ]);
    await page.reload();
    await expect(tiles(page)).toHaveCount(3);
    await expect(tiles(page).first()).toHaveAccessibleName(
      `Sheet Abra, Fixture Set 1, Reverse Holo, copy 1, Alpha ${s}`
    );
    await expectPageChecks(page, "phone Collection");

    // Names on, from Filters & display: the Variant line shows, and the page check still passes.
    await page.getByRole("button", { name: /^Filters & display/ }).click();
    const display = page.getByRole("dialog", { name: "Filters & display" });
    await display.getByRole("button", { name: "Names", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(display).toBeHidden();
    await expect(tiles(page).first()).toContainText(
      "fixture · 1 · Reverse Holo"
    );
    await expectPageChecks(page, "phone Collection, Names on");

    await tiles(page).first().tap();
    const sheet = page.getByRole("dialog", { name: "Sheet Abra" });
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText("fixture · 1");
    await expect(sheet).toContainText(/Variant\s*Reverse Holo/);
    await expect(sheet).toContainText("2 copies here");
    await expect(sheet).toContainText("3 copies owned");
    await expect(leaves(sheet)).toHaveText([
      `2 in Alpha ${s}`,
      `1 in Beta ${s}`,
    ]);
    // A bottom sheet: it reaches the bottom edge and the full width.
    const geometry = (await sheet.boundingBox())!;
    expect(Math.round(geometry.y + geometry.height)).toBe(812);
    expect(Math.round(geometry.width)).toBe(375);
    await expectPageChecks(page, "phone details sheet");

    await sheet.getByRole("button", { name: "Close details" }).tap();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(tiles(page).first()).toBeFocused();
    await tiles(page).nth(2).tap();
    await expect(
      page.getByRole("dialog", { name: "Sheet Abra" })
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(tiles(page).nth(2)).toBeFocused();
  });
});
