import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { Pool } from "pg";

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
  await page.getByLabel("Email", { exact: true }).fill(OWNER_EMAIL);
  await page.getByRole("button", { name: "Send code", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("code has been sent");
  await page.getByLabel("Six-digit code").fill(lastOtp());
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
}

const owner = async () =>
  (await pool.query('SELECT id FROM "user" WHERE email=$1', [OWNER_EMAIL]))
    .rows[0].id as string;

async function hold(editions: string[]) {
  const user = await owner();
  const leaf = (
    await pool.query(
      "SELECT id FROM location WHERE owner_id=$1 AND kind='storage_leaf' ORDER BY created_at LIMIT 1",
      [user]
    )
  ).rows[0].id;
  for (const edition of editions)
    await pool.query(
      "INSERT INTO holding(owner_id,location_id,edition_id,quantity,version) VALUES($1,$2,$3,1,1) ON CONFLICT(owner_id,location_id,edition_id) DO NOTHING",
      [user, leaf, edition]
    );
  await pool.query(
    "UPDATE inventory_owner SET revision=revision+1 WHERE user_id=$1",
    [user]
  );
  return leaf as string;
}

/** Prices are read when a slot mounts, so each check starts from a fresh page load. */
async function search(page: Page) {
  await page.reload();
  await page.getByRole("button", { name: "Catalog", exact: true }).click();
  await page.getByLabel("English name").fill("Furret");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.locator(".catalog-results > li")).toHaveCount(2);
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
  const results = page.locator(".catalog-results");
  await expect(results).toContainText("$0.25");
  await expect(results).toContainText("$0.43");
  await expect(results).toContainText("Age unknown");
  await expect(results).toContainText("Last checked");
  await expect(results).toContainText(
    "Price unavailable: finish not established"
  );
  await expect(results).not.toContainText("Stale");
  await expect(results).not.toContainText("$0.00");

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
  await expect(results).toContainText("Stale: the price is over 48 hours old");
  await expect(results).toContainText("$0.25");

  // Card detail lists the same exact-Edition answers.
  await page
    .locator(".catalog-results > li")
    .filter({ hasText: "$0.25" })
    .getByRole("button", { name: "View Editions" })
    .click();
  await expect(page.locator("article .edition-price")).toHaveCount(2);
  await expect(page.locator("article")).toContainText("$0.43");

  // Invalid cached decimals never render as a number.
  apply([{ op: "quote", edition: ids.normal, amount: "1e3" }]);
  await search(page);
  await expect(results).toContainText(
    "Price unavailable: the cached price failed validation"
  );
  await expect(results).not.toContainText("1000");

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
  await expect(results).toContainText(
    "Price unavailable: market matching is under review"
  );
  await expect(results).not.toContainText("$0.25");
});

test("Deck, leaf and Collection rows price their exact Edition, including after More cards", async ({
  page,
}) => {
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
  await hold(everything);
  await page.reload();

  // Leaf Holdings: 48 rows on the first page; only rendered rows are requested, 64 at a time at most.
  await page.getByRole("button", { name: "Unsorted" }).first().click();
  const panel = page.getByRole("region", { name: "Cards in Unsorted" });
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

  // Collection rows (aggregate rows count as Holding rows): the same Editions after More owned cards.
  await page.getByRole("button", { name: "Collection", exact: true }).click();
  await expect(page.locator(".holding-grid > li").first()).toBeVisible();
  await page.getByRole("button", { name: "More owned cards" }).click();
  await expect(
    page.locator(".holding-grid > li").filter({ hasText: "$0.25" })
  ).toHaveCount(1);
  await expect(
    page.locator(".holding-grid > li").filter({ hasText: "$0.43" })
  ).toHaveCount(1);
  await expect(
    page
      .locator(".holding-grid > li")
      .filter({ hasText: "finish not established" })
  ).toHaveCount(53);

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
  const rows = page.locator(".holding-grid > li");
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: "$0.25" })).toHaveCount(1);
  await expect(rows.filter({ hasText: "finish not established" })).toHaveCount(
    1
  );
});

test("a slow price route never blocks the rest of the page, then falls back to a labelled message", async ({
  page,
}) => {
  const ids = seed();
  apply([
    { op: "quote", edition: ids.normal, amount: "0.25", updated: ago(1) },
  ]);
  await signIn(page);
  await hold([ids.normal, ids["reverse-holofoil"]]);
  await page.reload();
  await page.route("**/api/prices/editions", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    await route.continue().catch(() => undefined);
  });
  await page.getByRole("button", { name: "Unsorted" }).first().click();
  const panel = page.getByRole("region", { name: "Cards in Unsorted" });
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
});

test("a gateway deadline answer becomes the same labelled fallback", async ({
  page,
}) => {
  const ids = seed();
  await signIn(page);
  await hold([ids.normal]);
  await page.reload();
  await page.route("**/api/prices/editions", (route) =>
    route.fulfill({
      status: 504,
      contentType: "application/json",
      body: JSON.stringify({ detail: { code: "PRICE_DEADLINE" } }),
    })
  );
  await page.getByRole("button", { name: "Unsorted" }).first().click();
  const panel = page.getByRole("region", { name: "Cards in Unsorted" });
  await expect(panel.getByText("Price check timed out").first()).toBeVisible();
  await expect(panel.locator(".holding-grid > li")).toHaveCount(1);
});
