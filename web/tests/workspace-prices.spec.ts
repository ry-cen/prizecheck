import { test, expect, type Page } from "@playwright/test";
import { signInAsOwner } from "./support/sign-in";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { Pool } from "pg";
import { expectTouchTarget } from "./support/touch-target";
import { startAsNewOwner } from "./support/owner";

// Ticket 111: the inspected Card Edition's price in the inspector, the opt-in Prices toggle that prices each
// mounted tile, and the inspector's metadata report link. Prices are the existing EditionPrice component and
// /api/prices/editions contract. Seeding mirrors prices.spec.ts and workspace-deck-heading.spec.ts: the price
// catalog through test_prices.ui_world, quotes written to the stack's real record store by ui_apply.
const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";
const OWNER_EMAIL = process.env.OWNER_EMAIL || "owner@example.test";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// A 1×1 PNG stands in for card artwork, so no test reaches the network.
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64"
);

/** Runs Python against the live stack's database, passing `argument` as a JSON file. */
function python(code: string, argument: object = {}): string {
  const path = `${process.env.TMPDIR || "/tmp"}/workspace-prices-${randomUUID()}.json`;
  writeFileSync(path, JSON.stringify(argument));
  return execFileSync(".venv/bin/python", ["-c", code, path], {
    env: { ...process.env, PYTHONPATH: "api:api/tests" },
    maxBuffer: 64 * 1024 * 1024,
  }).toString();
}

type PriceIds = {
  normal: string;
  "reverse-holofoil": string;
  unspecified: string;
  pagers: string[];
};
const ago = (hours: number) =>
  new Date(Date.now() - hours * 3_600_000).toISOString();
function quote(commands: object[]) {
  python(
    `import json, sys
from test_prices import ui_apply
ui_apply(json.load(open(sys.argv[1])))`,
    commands
  );
}
/** Replaces the catalog (and so every Holding) with Furret #1 normal ($0.25, an hour old) and reverse ($0.43,
 * three days old, so stale), Furret #2 as an unpriced Unspecified Variant, and `pagers` unpriced Printings
 * named "Aaa 00", "Aaa 01", … that sort before Furret. */
function priceWorld(pagers = 0): PriceIds {
  const out = python(
    `import json, sys
from test_prices import ui_world
print('WORLD' + json.dumps(ui_world(json.load(open(sys.argv[1]))['pagers'])))`,
    { pagers }
  );
  const ids = JSON.parse(out.slice(out.lastIndexOf("WORLD") + 5)) as PriceIds;
  quote([
    {
      op: "quote",
      edition: ids.normal,
      amount: "0.25",
      updated: ago(1),
      checked: ago(0.1),
    },
    {
      op: "quote",
      edition: ids["reverse-holofoil"],
      amount: "0.43",
      updated: ago(72),
      checked: ago(0.1),
    },
  ]);
  return ids;
}

async function signIn(page: Page) {
  await page.route(/^https:\/\/assets\.tcgdex\.net\//, (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: PIXEL })
  );
  await pool.query("DELETE FROM auth_send_event");
  await startAsNewOwner(pool);
  await signInAsOwner(page, "/collection");
  await expect(page).toHaveURL(/\/collection$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("All owned");
}

const owner = async () =>
  (await pool.query('SELECT id FROM "user" WHERE email=$1', [OWNER_EMAIL]))
    .rows[0].id as string;

/** A new top-level Storage Leaf through the gateway. */
async function createLeaf(page: Page, name: string): Promise<string> {
  const response = await page.request.post(`${ORIGIN}/api/location-tree`, {
    headers: { origin: ORIGIN },
    data: {
      name,
      parent_id: null,
      parent_version: null,
      idempotency_key: randomUUID(),
    },
  });
  expect(response.status()).toBe(201);
  return (await response.json()).location.id as string;
}

/** One copy of each Edition in `leaf`, stored by SQL with one revision bump (as prices.spec.ts). */
async function hold(leaf: string, editions: string[]) {
  const user = await owner();
  for (const edition of editions)
    await pool.query(
      "INSERT INTO holding(owner_id,location_id,edition_id,quantity,version) VALUES($1,$2,$3,1,1)",
      [user, leaf, edition]
    );
  await pool.query(
    "UPDATE inventory_owner SET revision=revision+1 WHERE user_id=$1",
    [user]
  );
}

/** Card name by Edition id: "Aaa NN" for pager-N, "Furret" for meta-1 and meta-2. */
async function editionNames(): Promise<Map<string, string>> {
  const { rows } = await pool.query(
    `SELECT e.id, p.source_id FROM catalog_edition e JOIN catalog_printing p ON p.id=e.printing_id`
  );
  return new Map(
    rows.map((row: { id: string; source_id: string }) => {
      const pager = /^pager-(\d+)$/.exec(row.source_id);
      return [
        row.id,
        pager ? `Aaa ${pager[1].padStart(2, "0")}` : "Furret",
      ] as const;
    })
  );
}

const cards = (page: Page) => page.getByRole("region", { name: "Cards" });
const tiles = (page: Page) => cards(page).getByRole("button");
const inspector = (page: Page) =>
  page.getByRole("complementary", { name: "Card details" });
const pricesToggle = (page: Page) =>
  page.getByRole("button", { name: "Prices", exact: true });
const counts = (page: Page, text: string) =>
  page.getByRole("main").getByText(text, { exact: true });
/** The tile whose label starts with `prefix` (labels read "<name>, <set> <number>, <Variant>, copy <n>, <path>"). */
const tile = (page: Page, prefix: string) =>
  cards(page).getByRole("button", {
    name: new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
  });
const REPORT = "Report a problem with this card's data";

/** Records every price request's Edition ids and the peak number in flight. */
async function recordPrices(page: Page) {
  const seen = { batches: [] as string[][], live: 0, peak: 0 };
  await page.route("**/api/prices/editions", async (route) => {
    seen.batches.push(route.request().postDataJSON().edition_ids);
    seen.live += 1;
    seen.peak = Math.max(seen.peak, seen.live);
    try {
      const response = await route.fetch();
      await route.fulfill({ response });
    } catch {
      /* The page navigated away mid-request. */
    } finally {
      seen.live -= 1;
    }
  });
  return seen;
}

test.afterEach(async () => {
  await pool.query("UPDATE catalog_rule_state SET activation_id=NULL");
});
test.afterAll(async () => {
  await pool.end();
});

test.describe("desktop", () => {
  test.use({ viewport: { width: 1600, height: 900 } });

  test("the inspector shows the inspected Edition's market price, an unavailable label when there is none, and never $0", async ({
    page,
  }) => {
    const ids = priceWorld();
    await signIn(page);
    const suffix = randomUUID().slice(0, 6);
    await hold(await createLeaf(page, `Fresh ${suffix}`), [ids.normal]);
    await hold(await createLeaf(page, `Old ${suffix}`), [
      ids["reverse-holofoil"],
    ]);
    await hold(await createLeaf(page, `Unpriced ${suffix}`), [ids.unspecified]);
    await page.reload();
    await expect(tiles(page)).toHaveCount(3);

    // Fresh quote: the amount alone, with no source, price time or last check.
    await tile(
      page,
      "Furret, Darkness Ablaze 1, Normal, copy 1, Fresh"
    ).click();
    await expect(inspector(page)).toContainText("$0.25");
    await expect(inspector(page)).not.toContainText("cached TCGplayer");
    await expect(inspector(page)).not.toContainText("Price time");
    await expect(inspector(page)).not.toContainText("Last checked");
    await expect(inspector(page)).not.toContainText("Stale");

    // Over 48 hours old: still priced, with no Stale label.
    await tile(
      page,
      "Furret, Darkness Ablaze 1, Reverse Holo, copy 1, Old"
    ).click();
    await expect(inspector(page)).toContainText("$0.43");
    await expect(inspector(page)).not.toContainText("Stale");

    // Unspecified Variant: unavailable, never a number.
    await tile(
      page,
      "Furret, Darkness Ablaze 2, Unspecified Variant, copy 1, Unpriced"
    ).click();
    await expect(inspector(page)).toContainText("Price unavailable");
    await expect(inspector(page)).not.toContainText("$");

    // Only the market price counts: an empty one is no price, even with a low and a mid price stored.
    quote([
      {
        op: "quote",
        edition: ids["reverse-holofoil"],
        amount: null,
        low: "0.40",
        mid: "0.45",
      },
    ]);
    await page.reload();
    await tile(
      page,
      "Furret, Darkness Ablaze 1, Reverse Holo, copy 1, Old"
    ).click();
    await expect(inspector(page)).toContainText("Price unavailable");
    await expect(inspector(page)).not.toContainText("$0.4");
    await expect(inspector(page)).not.toContainText("Age unknown");
  });

  test("a Printing with no TCGdex image shows TCGplayer art in its tile and the larger size in the inspector", async ({
    page,
  }) => {
    const ids = priceWorld();
    // The price world's cards carry no TCGdex image; Furret #1 gets TCGplayer product 777 as its fallback art.
    await pool.query(
      `INSERT INTO catalog_printing_fallback_art(printing_id, product_id)
       SELECT printing_id, 777 FROM catalog_edition WHERE id=$1
       ON CONFLICT (printing_id) DO UPDATE SET product_id=777`,
      [ids.normal]
    );
    const requested: string[] = [];
    await page.route(/^https:\/\/tcgplayer-cdn\.tcgplayer\.com\//, (route) => {
      requested.push(route.request().url());
      return route.fulfill({
        status: 200,
        contentType: "image/png",
        body: PIXEL,
      });
    });
    await signIn(page);
    await hold(await createLeaf(page, `Art ${randomUUID().slice(0, 6)}`), [
      ids.normal,
    ]);
    await page.reload();
    const card = tile(page, "Furret, Darkness Ablaze 1, Normal, copy 1");
    await expect(card.locator("img")).toHaveAttribute(
      "src",
      "https://tcgplayer-cdn.tcgplayer.com/product/777_200w.jpg"
    );
    await card.click();
    await expect(inspector(page).locator("img")).toHaveAttribute(
      "src",
      "https://tcgplayer-cdn.tcgplayer.com/product/777_400w.jpg"
    );
    expect(requested).toContain(
      "https://tcgplayer-cdn.tcgplayer.com/product/777_400w.jpg"
    );
  });

  test("a tile words a timed-out row like the inspector", async ({ page }) => {
    const ids = priceWorld();
    await signIn(page);
    await hold(await createLeaf(page, `Small ${randomUUID().slice(0, 6)}`), [
      ids["reverse-holofoil"],
      ids.unspecified,
    ]);
    // The second Edition's row is a server-side deadline.
    quote([
      {
        op: "quote",
        edition: ids["reverse-holofoil"],
        amount: "0.43",
        updated: ago(2),
      },
    ]);
    await page.route("**/api/prices/editions", async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      for (const row of body.prices)
        if (row.edition_id === ids.unspecified) {
          row.status = "unavailable";
          row.reason = "deadline";
        }
      await route.fulfill({ response, json: body });
    });
    await page.mouse.move(0, 0);
    await page.reload();
    await expect(tiles(page)).toHaveCount(2);
    await pricesToggle(page).click();

    await expect(
      tile(page, "Furret, Darkness Ablaze 2, ")
    ).toHaveAccessibleDescription("Price check timed out");
    await expect(tile(page, "Furret, Darkness Ablaze 2, ")).toContainText(
      "Price check timed out"
    );
  });

  test("a price check that runs out of time is labelled in the inspector and the card details still show", async ({
    page,
  }) => {
    const ids = priceWorld();
    await signIn(page);
    await hold(await createLeaf(page, `Late ${randomUUID().slice(0, 6)}`), [
      ids.normal,
    ]);
    await page.route("**/api/prices/editions", (route) =>
      route.fulfill({
        status: 504,
        contentType: "application/json",
        body: JSON.stringify({ detail: { code: "PRICE_DEADLINE" } }),
      })
    );
    await page.reload();
    await tile(page, "Furret, Darkness Ablaze 1").click();
    await expect(inspector(page)).toContainText("Price check timed out");
    await expect(inspector(page)).toContainText("1 copy here");
    await expect(inspector(page)).not.toContainText("$0.00");
  });

  test("the inspector links to the metadata report form preset to the inspected Edition", async ({
    page,
  }) => {
    const ids = priceWorld();
    await signIn(page);
    await hold(await createLeaf(page, `Report ${randomUUID().slice(0, 6)}`), [
      ids.normal,
    ]);
    const printing = (
      await pool.query("SELECT printing_id FROM catalog_edition WHERE id=$1", [
        ids.normal,
      ])
    ).rows[0].printing_id as string;
    await page.reload();
    await tile(page, "Furret, Darkness Ablaze 1").click();
    const link = inspector(page).getByRole("link", { name: REPORT });
    await expect(link).toHaveAttribute(
      "href",
      `/catalog?printing=${printing}&edition=${ids.normal}`
    );

    await link.click();
    // The catalog reads the link once and removes it from the address.
    await expect(page).toHaveURL(/\/catalog$/);
    const report = page.getByRole("region", { name: "Report card metadata" });
    await expect(report).toBeVisible();
    await expect(
      report.getByRole("heading", { name: "Report card metadata for Furret" })
    ).toBeVisible();
    const target = report
      .locator("label", { hasText: "What needs fixing" })
      .locator("select");
    await expect(target).toHaveValue("marketplace");
    await expect(target).toBeFocused();
    await expect(
      report.locator("label", { hasText: "Card Edition" }).locator("select")
    ).toHaveValue(ids.normal);
    // The plain catalog search opens after a reload.
    await page.reload();
    await expect(
      page.getByRole("region", { name: "Report card metadata" })
    ).toHaveCount(0);
  });
});

test.describe("desktop, short window", () => {
  // A short window keeps most of the 102 tiles outside the mounted rows (one viewport above and below).
  test.use({ viewport: { width: 1600, height: 700 } });

  test("Prices is off by default, prices only mounted tiles in batches of at most 64 with two in flight, and is remembered", async ({
    page,
  }) => {
    const ids = priceWorld(99);
    await signIn(page);
    const furret = [ids.normal, ids["reverse-holofoil"], ids.unspecified];
    await hold(await createLeaf(page, `Gallery ${randomUUID().slice(0, 6)}`), [
      ...ids.pagers,
      ...furret,
    ]);
    const names = await editionNames();
    const seen = await recordPrices(page);
    // Park the pointer off the gallery, so no hover preview asks for a price.
    await page.mouse.move(0, 0);
    await page.reload();
    await expect(counts(page, "102 copies · 102 editions")).toBeVisible();
    await expect(tile(page, "Aaa 00, ")).toBeVisible();

    // Off by default: no tile shows or requests a price.
    await expect(pricesToggle(page)).toHaveAttribute("aria-pressed", "false");
    // flake-exempt wait-for-timeout (quiet): with Prices off, no tile may ask for a price in this window.
    await page.waitForTimeout(300);
    expect(seen.batches).toEqual([]);
    // Without a price line the description is the tile's hover title.
    await expect(tile(page, "Aaa 00, ")).toHaveAccessibleDescription(
      /^Aaa 00 · /
    );
    await expect(cards(page).getByText("Price unavailable")).toHaveCount(0);
    // The Furret tiles sort last and are not mounted.
    await expect(tile(page, "Furret, ")).toHaveCount(0);

    // On: each mounted tile shows its Edition's price under it; only mounted Editions are requested.
    await pricesToggle(page).click();
    await expect(pricesToggle(page)).toHaveAttribute("aria-pressed", "true");
    await expect(tile(page, "Aaa 00, ")).toHaveAccessibleDescription(
      "Price unavailable"
    );
    await expect(cards(page).getByText("Checking prices…")).toHaveCount(0);
    const mounted = new Set(
      (
        await tiles(page).evaluateAll((elements) =>
          elements.map((element) => element.getAttribute("aria-label") ?? "")
        )
      ).map((label) => label.split(", ")[0])
    );
    const requested = new Set(seen.batches.flat());
    expect(requested.size).toBeGreaterThan(0);
    expect(requested.size).toBeLessThan(102);
    for (const id of requested) expect(mounted).toContain(names.get(id));
    for (const id of furret) expect(requested.has(id)).toBe(false);

    // Scrolling down mounts the Furret tiles, which then request and show their own prices.
    await page.evaluate(() =>
      window.scrollTo(0, document.documentElement.scrollHeight)
    );
    await expect(tile(page, "Furret, ")).toHaveCount(3);
    await expect(
      tiles(page).filter({ hasText: "$0.25" })
    ).toHaveAccessibleDescription("$0.25");
    await expect(
      tiles(page).filter({ hasText: "$0.43" })
    ).toHaveAccessibleDescription("$0.43");
    await expect(
      tile(page, "Furret, Darkness Ablaze 2, ")
    ).toHaveAccessibleDescription("Price unavailable");
    await expect(cards(page)).not.toContainText("$0.00");
    for (const id of furret) expect(seen.batches.flat()).toContain(id);
    expect(seen.batches.every((batch) => batch.length <= 64)).toBe(true);
    expect(seen.peak).toBeLessThanOrEqual(2);

    // No price sort, price filter or value total.
    const sorts = await page
      .getByLabel("Sort", { exact: true })
      .locator("option")
      .allTextContents();
    expect(sorts.some((label) => /price|value|\$/i.test(label))).toBe(false);
    await page.getByRole("button", { name: /^Filters/ }).click();
    await expect(
      page.getByRole("region", { name: "Card filters" }).getByText(/price/i)
    ).toHaveCount(0);
    await expect(counts(page, "102 copies · 102 editions")).toBeVisible();

    // Remembered with the other display preferences.
    await page.reload();
    await expect(pricesToggle(page)).toHaveAttribute("aria-pressed", "true");
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(tile(page, "Aaa 00, ")).toHaveAccessibleDescription(
      "Price unavailable"
    );
    await pricesToggle(page).click();
    await expect(pricesToggle(page)).toHaveAttribute("aria-pressed", "false");
    await page.reload();
    await expect(pricesToggle(page)).toHaveAttribute("aria-pressed", "false");
    await expect(tile(page, "Aaa 00, ")).toHaveAccessibleDescription(
      /^Aaa 00 · /
    );
    await expect(cards(page).getByText("Price unavailable")).toHaveCount(0);
  });
});

test.describe("mobile", () => {
  test.use({
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
  });

  test("Prices is in Filters & display, and the details sheet shows the price and the report link", async ({
    page,
  }) => {
    const ids = priceWorld();
    await signIn(page);
    await hold(await createLeaf(page, `Phone ${randomUUID().slice(0, 6)}`), [
      ids.normal,
    ]);
    await page.reload();
    await expect(tiles(page)).toHaveCount(1);

    const opener = page.getByRole("button", { name: /^Filters & display/ });
    await opener.click();
    const drawer = page.getByRole("dialog", { name: "Filters & display" });
    const toggle = drawer.getByRole("button", { name: "Prices", exact: true });
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expectTouchTarget(toggle, ["height"]);
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(tiles(page).first()).toHaveAccessibleDescription("$0.25");

    await tiles(page).first().tap();
    const sheet = page.getByRole("dialog", { name: "Furret" });
    await expect(sheet).toContainText("$0.25");
    await expect(sheet).not.toContainText("cached TCGplayer");
    const link = sheet.getByRole("link", { name: REPORT });
    await expect(link).toBeVisible();
    await expectTouchTarget(link, ["height"]);
  });
});
