import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { Pool } from "pg";
import { openDeckTools } from "./support/deck-builder";

const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";
const OWNER_EMAIL = process.env.OWNER_EMAIL || "owner@example.test";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

type Ids = {
  normal: string;
  "reverse-holofoil": string;
  unspecified: string;
  pagers: string[];
};
const python = (code: string, argument: object) => {
  const path = `${process.env.TMPDIR || "/tmp"}/prices-${randomUUID()}.json`;
  writeFileSync(path, JSON.stringify(argument));
  return execFileSync(".venv/bin/python", ["-c", code, path], {
    env: { ...process.env, PYTHONPATH: "api:api/tests" },
    maxBuffer: 64 * 1024 * 1024,
  }).toString();
};
/** Catalog fixtures may use SQL and the importer; prices are written to the live stack's real record store. */
function seed(pagers = 0): Ids {
  const out = python(
    `import json, sys
from test_prices import ui_world
print('WORLD' + json.dumps(ui_world(json.load(open(sys.argv[1]))['pagers'])))`,
    { pagers }
  );
  return JSON.parse(out.slice(out.lastIndexOf("WORLD") + 5));
}
function apply(commands: object[]) {
  python(
    `import json, sys
from test_prices import ui_apply
ui_apply(json.load(open(sys.argv[1])))`,
    commands
  );
}
const ago = (hours: number) =>
  new Date(Date.now() - hours * 3_600_000).toISOString();

const lastOtp = () =>
  JSON.parse(
    readFileSync(process.env.MAIL_FILE!, "utf8").trim().split("\n").at(-1)!
  ).otp as string;

async function signIn(page: Page) {
  await pool.query("DELETE FROM auth_send_event");
  await page.goto(`${ORIGIN}/locations`);
  await expect(page).toHaveURL(/\/collection(\?|$)/);
  await page.getByLabel("Email", { exact: true }).fill(OWNER_EMAIL);
  await page.getByRole("button", { name: "Send code", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("code has been sent");
  await page.getByLabel("Six-digit code").fill(lastOtp());
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("navigation", { name: "Main views" })
  ).toBeVisible();
}

const owner = async () =>
  (await pool.query('SELECT id FROM "user" WHERE email=$1', [OWNER_EMAIL]))
    .rows[0].id as string;

/** Stocks a new Deck with one copy of each Edition, through the Decks page's Holdings panel (the old Locations page
 * that showed leaf rows is gone, ticket 114). The "0 " prefix keeps it on the first page of 30 Decks by name. */
async function hold(page: Page, editions: string[]): Promise<string> {
  const name = `0 Held ${randomUUID().slice(0, 8)}`;
  const created = await page.request.post(`${ORIGIN}/api/decks`, {
    headers: { origin: ORIGIN },
    data: { name, idempotency_key: randomUUID() },
  });
  expect(created.status()).toBe(201);
  const deck = (await created.json()).location.id as string;
  const user = await owner();
  for (const edition of editions)
    await pool.query(
      "INSERT INTO holding(owner_id,location_id,edition_id,quantity,version) VALUES($1,$2,$3,1,1) ON CONFLICT(owner_id,location_id,edition_id) DO NOTHING",
      [user, deck, edition]
    );
  await pool.query(
    "UPDATE inventory_owner SET revision=revision+1 WHERE user_id=$1",
    [user]
  );
  return name;
}

/** Opens the held Deck's Holdings rows on the Decks page. */
async function openHeld(page: Page, name: string) {
  await page.getByRole("button", { name: "Decks", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Deck index" })
    .getByRole("button", { name, exact: true })
    .click();
  await openDeckTools(page);
  const panel = page.getByRole("region", { name: `Cards in ${name}` });
  await expect(panel).toBeVisible();
  return panel;
}

/** Prices are read once, when a slot first comes near the viewport, so each check starts from a fresh page load.
 * Catalog is an Edition gallery (#173): Furret's three Editions are three tiles, each with its compact price. */
async function search(page: Page) {
  await page.reload();
  await page.getByRole("button", { name: "Catalog", exact: true }).click();
  await page
    .getByRole("searchbox", { name: "Search the catalog" })
    .fill("Furret");
  await expect(
    page.getByRole("region", { name: "Catalog results" }).getByRole("listitem")
  ).toHaveCount(3);
}

/** A gallery tile by the start of its accessible name ("Furret, DAA 1, Darkness Ablaze, Normal"). */
const tile = (page: Page, start: string) =>
  page
    .getByRole("region", { name: "Catalog results" })
    .getByRole("button", { name: new RegExp(`^${start}`) });

/** Opens a tile's card popup (#174): its Edition picker prices every Edition of the Printing in one short line, and the
 * picked Edition (the tile's) gets the full price sentence. */
async function details(page: Page, start: string) {
  await tile(page, start).click();
  const dialog = page.getByRole("dialog", { name: "Furret" });
  await expect(
    dialog.getByRole("group", { name: "Selected Edition" })
  ).toBeVisible();
  return dialog;
}

test.afterEach(async () => {
  await pool.query("UPDATE catalog_rule_state SET activation_id=NULL");
});
test.afterAll(async () => {
  await pool.end();
});

test("card information shows each Edition's own price with age, stale and finish labels, and PostgreSQL state wins", async ({
  page,
}) => {
  const ids = seed();
  apply([
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
      amount: "0.4349",
      updated: null,
    },
  ]);
  await signIn(page);
  await search(page);
  // Each tile prices its own Edition in one short line.
  await expect(
    tile(page, "Furret, DAA 1, Darkness Ablaze, Normal")
  ).toContainText("$0.25");
  await expect(
    tile(page, "Furret, DAA 1, Darkness Ablaze, Reverse Holo")
  ).toContainText("$0.43");
  // The popup prices each Edition in its picker and gives the picked one the full sentence.
  let card = await details(page, "Furret, DAA 1, Darkness Ablaze, Normal");
  await expect(card).toContainText("$0.25");
  await expect(card).toContainText("$0.43");
  await expect(card).toContainText("Age unknown");
  await expect(card).toContainText("Last checked");
  await expect(card).not.toContainText("Stale");
  await expect(card).not.toContainText("$0.00");
  await expect(
    card.getByRole("group", { name: "Editions" }).locator(".edition-price")
  ).toHaveCount(2);
  const picked = card.getByRole("group", { name: "Selected Edition" });
  await expect(picked.locator(".edition-price")).toHaveCount(1);
  await expect(picked).toContainText("$0.25");
  await expect(picked).toContainText("Last checked");
  // Picking the Reverse Holo gives it the full sentence: no provider time, so its age is unknown.
  await card
    .getByRole("group", { name: "Editions" })
    .getByRole("button", { name: /^Reverse Holo/ })
    .click();
  await expect(picked).toContainText("$0.43");
  await expect(picked).toContainText("Age unknown");
  await page.keyboard.press("Escape");
  card = await details(page, "Furret, DAA 2,");
  await expect(card).toContainText("Price unavailable: finish not established");

  // Stale: strictly over 48 hours of provider age, even though the check is fresh.
  apply([
    {
      op: "quote",
      edition: ids.normal,
      amount: "0.25",
      updated: ago(72),
      checked: ago(0.01),
    },
  ]);
  await search(page);
  await expect(
    tile(page, "Furret, DAA 1, Darkness Ablaze, Normal")
  ).toContainText("Stale");
  card = await details(page, "Furret, DAA 1, Darkness Ablaze, Normal");
  await expect(card).toContainText("Stale: the price is over 48 hours old");
  await expect(card).toContainText("$0.25");
  await expect(card).toContainText("$0.43");

  // Invalid cached decimals never render as a number.
  apply([{ op: "quote", edition: ids.normal, amount: "1e3" }]);
  await search(page);
  card = await details(page, "Furret, DAA 1, Darkness Ablaze, Normal");
  await expect(card).toContainText(
    "Price unavailable: the cached price failed validation"
  );
  await expect(card).not.toContainText("1000");

  // A PostgreSQL quarantine hides the quote before anything reaches the store.
  apply([
    {
      op: "quote",
      edition: ids.normal,
      amount: "0.25",
      updated: ago(1),
    },
    {
      op: "sql",
      edition: ids.normal,
      statement:
        "UPDATE catalog_edition_metadata SET mapping_state='quarantined',mapping_reason='candidate_changed' WHERE edition_id=%s",
    },
  ]);
  await search(page);
  card = await details(page, "Furret, DAA 1, Darkness Ablaze, Normal");
  await expect(card).toContainText(
    "Price unavailable: market matching is under review"
  );
  await expect(card).not.toContainText("$0.25");
});

test("Deck rows and Collection tiles price their exact Edition, including after More cards and a scroll", async ({
  page,
}) => {
  // Tall enough that every row of each page is near the viewport, so every rendered slot asks at once.
  await page.setViewportSize({ width: 1280, height: 2000 });
  const ids = seed(52);
  apply([
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
      updated: ago(5),
    },
  ]);
  const requested: string[][] = [];
  await page.route("**/api/prices/editions", async (route) => {
    requested.push(route.request().postDataJSON().edition_ids);
    await route.continue();
  });
  await signIn(page);
  const everything = [
    ...ids.pagers,
    ids.normal,
    ids["reverse-holofoil"],
    ids.unspecified,
  ];
  const held = await hold(page, everything);
  await page.reload();

  // Deck Holdings: 48 rows on the first page; only rendered rows are requested, 64 at a time at most.
  const panel = await openHeld(page, held);
  await expect(panel.locator(".holding-grid > li")).toHaveCount(48);
  await expect(panel.locator(".edition-price").first()).not.toContainText(
    "Checking prices"
  );
  await expect(panel).not.toContainText("$0.25");
  expect(new Set(requested.flat()).size).toBeLessThanOrEqual(48);
  await panel.getByRole("button", { name: "More cards" }).click();
  await expect(panel.locator(".holding-grid > li")).toHaveCount(55);
  await expect(panel).toContainText("$0.25");
  await expect(panel).toContainText("$0.43");
  expect(requested.every((batch) => batch.length <= 64)).toBe(true);
  expect(new Set(requested.flat()).size).toBe(55);

  // Collection's tiles (the old Collection page is retired, #164): with Prices on, each copy's price line
  // shows its own Edition's price, including the last tiles, which mount only once the gallery reaches them.
  await page.getByRole("button", { name: "Collection", exact: true }).click();
  await expect(
    page.getByRole("main").getByText("55 copies · 55 editions", { exact: true })
  ).toBeVisible();
  await page.getByRole("button", { name: "Prices", exact: true }).click();
  await page.evaluate(() =>
    window.scrollTo(0, document.documentElement.scrollHeight)
  );
  const tile = (prefix: RegExp) =>
    page.getByRole("region", { name: "Cards" }).getByRole("button", {
      name: prefix,
    });
  await expect(tile(/^Furret, Darkness Ablaze 1, Normal, /)).toContainText(
    "$0.25"
  );
  await expect(
    tile(/^Furret, Darkness Ablaze 1, Reverse Holo, /)
  ).toContainText("$0.43");
  await expect(
    tile(/^Furret, Darkness Ablaze 2, Unspecified Variant, /)
  ).toContainText("Price unavailable");
  expect(requested.every((batch) => batch.length <= 64)).toBe(true);

  // A Deck's Holdings rows.
  const name = `Priced ${randomUUID().slice(0, 8)}`;
  const created = await page.request.post(`${ORIGIN}/api/decks`, {
    headers: { origin: ORIGIN },
    data: { name, idempotency_key: randomUUID() },
  });
  expect(created.status()).toBe(201);
  const deck = (await created.json()).location.id as string;
  const user = await owner();
  for (const edition of [ids.normal, ids.unspecified])
    await pool.query(
      "INSERT INTO holding(owner_id,location_id,edition_id,quantity,version) VALUES($1,$2,$3,2,1)",
      [user, deck, edition]
    );
  await pool.query(
    "UPDATE inventory_owner SET revision=revision+1 WHERE user_id=$1",
    [user]
  );
  await page.getByRole("button", { name: "Decks", exact: true }).click();
  await page.getByRole("button", { name, exact: true }).click();
  await openDeckTools(page);
  const rows = page.locator(".holding-grid > li");
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: "$0.25" })).toHaveCount(1);
  await expect(rows.filter({ hasText: "finish not established" })).toHaveCount(
    1
  );
});

// @slow (wall-clock): the stalled route waits 6 s of real time before the fallback.
test(
  "a slow price route never blocks the rest of the page, then falls back to a labelled message",
  { tag: "@slow" },
  async ({ page }) => {
    const ids = seed();
    apply([
      { op: "quote", edition: ids.normal, amount: "0.25", updated: ago(1) },
    ]);
    await signIn(page);
    const held = await hold(page, [ids.normal, ids["reverse-holofoil"]]);
    await page.reload();
    await page.route("**/api/prices/editions", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      await route.continue().catch(() => undefined);
    });
    const panel = await openHeld(page, held);
    // The cards are there at once; only the price slots wait.
    await expect(panel.locator(".holding-grid > li")).toHaveCount(2);
    await expect(panel.getByText("Furret").first()).toBeVisible();
    await expect(panel.getByText("Checking prices…").first()).toBeVisible();
    await expect(panel.getByRole("button", { name: "Search" })).toHaveCount(0);
    await expect(panel.getByText("Price check timed out").first()).toBeVisible({
      timeout: 8_000,
    });
    await expect(panel.getByText("Checking prices…")).toHaveCount(0);
    await expect(panel.locator(".holding-grid > li")).toHaveCount(2);
  }
);

test("a gateway deadline answer becomes the same labelled fallback", async ({
  page,
}) => {
  const ids = seed();
  await signIn(page);
  const held = await hold(page, [ids.normal]);
  await page.reload();
  await page.route("**/api/prices/editions", (route) =>
    route.fulfill({
      status: 504,
      contentType: "application/json",
      body: JSON.stringify({ detail: { code: "PRICE_DEADLINE" } }),
    })
  );
  const panel = await openHeld(page, held);
  await expect(panel.getByText("Price check timed out").first()).toBeVisible();
  await expect(panel.locator(".holding-grid > li")).toHaveCount(1);
});

const REFRESH_LABELS: [string | null, string | null, RegExp | null][] = [
  ["background", null, /Refreshing in background/],
  ["refreshed", null, /Refreshed just now/],
  ["timeout", null, /Refresh timed out — showing cached/],
  ["busy", null, /Refresh busy — showing cached/],
  ["backoff", null, /Source backing off — showing cached/],
  [
    "failed",
    "2026-01-02T03:04:05+00:00",
    /Last refresh failed at 2026-01-02 03:04 UTC — showing cached/,
  ],
  [null, null, null],
];

test("each refresh outcome has its own label and never changes the cached price shown", async ({
  page,
}) => {
  const ids = seed();
  apply([
    {
      op: "quote",
      edition: ids.normal,
      amount: "0.25",
      updated: ago(1),
      checked: ago(0.1),
    },
  ]);
  await signIn(page);
  const held = await hold(page, [ids.normal]);
  for (const [refresh, failedAt, label] of REFRESH_LABELS) {
    await page.route("**/api/prices/editions", async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      for (const row of body.prices) {
        row.refresh = refresh;
        row.refresh_failed_at = failedAt;
      }
      await route.fulfill({ response, json: body });
    });
    await page.reload();
    const panel = await openHeld(page, held);
    const slot = panel.locator(".edition-price").first();
    await expect(slot).toContainText("$0.25");
    if (label) await expect(slot).toContainText(label);
    else await expect(slot.locator(".price-refresh")).toHaveCount(0);
    await expect(slot).not.toContainText("$0.00");
    await expect(slot.getByRole("button")).toHaveCount(0);
    await page.unroute("**/api/prices/editions");
  }
});

// @slow (sleep): waits 1.8 s of real time while batches queue.
test(
  "at most two price batches are in flight, later ones queue, and nothing is polled or retried",
  { tag: "@slow" },
  async ({ page }) => {
    // Tall enough that every row of each page is near the viewport, so every rendered slot asks at once.
    await page.setViewportSize({ width: 1280, height: 2000 });
    const ids = seed(110);
    await signIn(page);
    const held = await hold(page, [
      ...ids.pagers,
      ids.normal,
      ids["reverse-holofoil"],
      ids.unspecified,
    ]);
    await page.reload();
    const seen: string[][] = [];
    let live = 0;
    let peak = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route("**/api/prices/editions", async (route) => {
      seen.push(route.request().postDataJSON().edition_ids);
      live += 1;
      peak = Math.max(peak, live);
      await gate;
      live -= 1;
      await route.continue().catch(() => undefined);
    });
    const panel = await openHeld(page, held);
    await expect(panel.locator(".holding-grid > li")).toHaveCount(48);
    await panel.getByRole("button", { name: "More cards" }).click();
    await expect(panel.locator(".holding-grid > li")).toHaveCount(96);
    await panel.getByRole("button", { name: "More cards" }).click();
    await expect(panel.locator(".holding-grid > li")).toHaveCount(113);
    await expect.poll(() => seen.length).toBe(2);
    // flake-exempt wait-for-timeout (quiet): while two batches are held, a third must not start.
    await page.waitForTimeout(800);
    expect(seen).toHaveLength(2);
    expect(peak).toBe(2);
    release();
    await expect.poll(() => seen.length).toBe(3);
    // flake-exempt wait-for-timeout (quiet): once the queue has drained, nothing is polled or retried.
    await page.waitForTimeout(1_000);
    expect(peak).toBeLessThanOrEqual(2);
    expect(seen.every((batch) => batch.length <= 64)).toBe(true);
    expect(seen.flat()).toHaveLength(113);
    expect(new Set(seen.flat()).size).toBe(113);
  }
);

test("following a link does not prefetch prices for unrendered cards", async ({
  page,
}) => {
  const ids = seed();
  await signIn(page);
  const held = await hold(page, [ids.normal]);
  await page.reload();
  const seen: string[][] = [];
  await page.route("**/api/prices/editions", async (route) => {
    seen.push(route.request().postDataJSON().edition_ids);
    await route.continue();
  });
  const panel = await openHeld(page, held);
  await expect(panel.locator(".edition-price").first()).not.toContainText(
    "Checking prices"
  );
  expect(seen.flat()).toEqual([ids.normal]);
  // The shell's skip link is parked off screen until it has focus; it cannot be hovered. Every other link can.
  for (const link of await page
    .locator("a[href]")
    .filter({ hasNotText: "Skip to main content" })
    .all())
    await link.hover();
  // flake-exempt wait-for-timeout (quiet): a hover must not prefetch, and a prefetch would start within this window.
  await page.waitForTimeout(500);
  expect(seen.flat()).toEqual([ids.normal]);
});

test("price slots ask only once they come near the viewport, and each Edition once", async ({
  page,
}) => {
  const ids = seed(52);
  await signIn(page);
  const held = await hold(page, [
    ...ids.pagers,
    ids.normal,
    ids["reverse-holofoil"],
    ids.unspecified,
  ]);
  // A short window: the near area (two viewport heights) ends well above the last of the page's 48 rows.
  await page.setViewportSize({ width: 1280, height: 300 });
  await page.reload();
  const requested: string[][] = [];
  await page.route("**/api/prices/editions", async (route) => {
    requested.push(route.request().postDataJSON().edition_ids);
    await route.continue();
  });
  const panel = await openHeld(page, held);
  const rows = panel.locator(".holding-grid > li");
  await expect(rows).toHaveCount(48);
  await rows.first().scrollIntoViewIfNeeded();
  await expect(rows.first().locator(".edition-price")).not.toContainText(
    "Checking prices"
  );
  // The last row has not asked yet.
  await expect(rows.last().locator(".edition-price")).toHaveAttribute(
    "data-price-status",
    "checking"
  );
  const before = new Set(requested.flat()).size;
  expect(before).toBeGreaterThan(0);
  expect(before).toBeLessThan(48);
  // Scrolling to it asks for it, and no Edition is ever asked for twice.
  await rows.last().scrollIntoViewIfNeeded();
  await expect(rows.last().locator(".edition-price")).not.toContainText(
    "Checking prices"
  );
  expect(new Set(requested.flat()).size).toBeGreaterThan(before);
  expect(requested.flat()).toHaveLength(new Set(requested.flat()).size);
});

test("without IntersectionObserver every rendered slot asks at once", async ({
  page,
}) => {
  await page.addInitScript(() => {
    delete (window as { IntersectionObserver?: unknown }).IntersectionObserver;
  });
  const ids = seed(52);
  await signIn(page);
  const held = await hold(page, [
    ...ids.pagers,
    ids.normal,
    ids["reverse-holofoil"],
    ids.unspecified,
  ]);
  await page.setViewportSize({ width: 1280, height: 300 });
  await page.reload();
  const requested: string[][] = [];
  await page.route("**/api/prices/editions", async (route) => {
    requested.push(route.request().postDataJSON().edition_ids);
    await route.continue();
  });
  const panel = await openHeld(page, held);
  const rows = panel.locator(".holding-grid > li");
  await expect(rows).toHaveCount(48);
  await expect.poll(() => new Set(requested.flat()).size).toBe(48);
  await expect(rows.last().locator(".edition-price")).not.toContainText(
    "Checking prices"
  );
});
