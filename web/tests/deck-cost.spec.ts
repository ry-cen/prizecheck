import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { Pool } from "pg";
import { openDeckTools } from "./support/deck-builder";

// Ticket 09: Estimated Deck Cost and Pricing Coverage on the real stack (browser -> gateway -> API -> PostgreSQL and
// the record store). Quotes are written to the live stack's store the way a runner writes them; nothing here sums rows
// in the browser, so a total proves the server read every copy.
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
  const path = `${process.env.TMPDIR || "/tmp"}/deck-cost-${randomUUID()}.json`;
  writeFileSync(path, JSON.stringify(argument));
  return execFileSync(".venv/bin/python", ["-c", code, path], {
    env: { ...process.env, PYTHONPATH: "api:api/tests" },
    maxBuffer: 64 * 1024 * 1024,
  }).toString();
};
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

/** A Deck holding `{edition: quantity}`, written straight to PostgreSQL with one inventory revision bump. */
async function deckWith(page: Page, quantities: Record<string, number>) {
  const name = `Cost ${randomUUID().slice(0, 8)}`;
  const created = await page.request.post(`${ORIGIN}/api/decks`, {
    headers: { origin: ORIGIN },
    data: { name, idempotency_key: randomUUID() },
  });
  expect(created.status()).toBe(201);
  const id = (await created.json()).location.id as string;
  const user = await owner();
  for (const [edition, quantity] of Object.entries(quantities))
    await pool.query(
      "INSERT INTO holding(owner_id,location_id,edition_id,quantity,version) VALUES($1,$2,$3,$4,1)",
      [user, id, edition, quantity]
    );
  await pool.query(
    "UPDATE inventory_owner SET revision=revision+1 WHERE user_id=$1",
    [user]
  );
  return { id, name };
}
/** Opens the Deck from a fresh load of the Decks index: a reload on the deck builder would read the cost once more. */
async function openDeck(page: Page, name: string) {
  await page.goto(`${ORIGIN}/decks`);
  await page.getByRole("button", { name, exact: true }).click();
  await openDeckTools(page);
  return page.getByRole("region", { name: "Estimated Deck Cost" });
}
const sixCopies = (ids: Ids) => {
  apply([
    {
      op: "quote",
      edition: ids.normal,
      amount: "0.25",
      updated: ago(1),
      checked: ago(0.1),
    },
    // Provider time three days old; the successful check is six minutes old. Only provider age decides "stale".
    {
      op: "quote",
      edition: ids["reverse-holofoil"],
      amount: "0.43",
      updated: ago(72),
      checked: ago(0.1),
    },
  ]);
};

test.afterEach(async () => {
  await pool.query("UPDATE catalog_rule_state SET activation_id=NULL");
});
test.afterAll(async () => {
  await pool.end();
});

test("three $0.25 copies, two stale $0.43 copies and one unpriced copy show $1.61 and 5/6 priced", async ({
  page,
}) => {
  const ids = seed();
  sixCopies(ids);
  await signIn(page);
  const deck = await deckWith(page, {
    [ids.normal]: 3,
    [ids["reverse-holofoil"]]: 2,
    [ids.unspecified]: 1,
  });
  const cost = await openDeck(page, deck.name);
  await expect(cost).toContainText("$1.61 · 5/6 cards priced");
  await expect(cost).toContainText(
    "Incomplete subtotal: 1 card without a price"
  );
  await expect(cost).toContainText("2 stale cards (price over 48 hours old)");
  await expect(cost).toContainText("0 cards with unknown price age");
  await expect(cost).toContainText("Excludes shipping and taxes");
  await expect(cost).not.toContainText("$0.00");
  // The checks and the rows are independent of the cost.
  await expect(
    page.getByRole("region", { name: `Checks for ${deck.name}` })
  ).toContainText("6 cards");
});

test("a Deck spread over several Holding pages is priced in full before More cards is pressed", async ({
  page,
}) => {
  const ids = seed(52);
  sixCopies(ids);
  await signIn(page);
  const quantities: Record<string, number> = {
    [ids.normal]: 3,
    [ids["reverse-holofoil"]]: 2,
    [ids.unspecified]: 1,
  };
  for (const pager of ids.pagers) quantities[pager] = 1;
  const deck = await deckWith(page, quantities);
  const requested: string[] = [];
  await page.route("**/api/decks/*/cost", async (route) => {
    requested.push(route.request().url());
    await route.continue();
  });
  const cost = await openDeck(page, deck.name);
  const rows = page
    .getByRole("region", { name: `Cards in ${deck.name}` })
    .locator(".holding-grid > li");
  await expect(rows).toHaveCount(48);
  // "Aaa" pagers sort first, so the priced Furret Editions are not on the rendered page at all.
  await expect(rows.filter({ hasText: "$0.25" })).toHaveCount(0);
  await expect(cost).toContainText("$1.61 · 5/58 cards priced");
  await expect(cost).toContainText(
    "Incomplete subtotal: 53 cards without a price"
  );
  expect(requested).toHaveLength(1);
});

test("an empty Deck is $0.00 with No cards, and a Deck with no eligible quote is 0/N priced", async ({
  page,
}) => {
  const ids = seed();
  await signIn(page);
  const empty = await deckWith(page, {});
  let cost = await openDeck(page, empty.name);
  await expect(cost).toContainText("$0.00 · No cards");

  apply([
    {
      op: "quote",
      edition: ids.normal,
      result: {
        state: "absent",
        checked_at: ago(0.1),
        expires_at: ago(-0.9),
      },
    },
  ]);
  const unpriced = await deckWith(page, {
    [ids.normal]: 2,
    [ids.unspecified]: 4,
  });
  cost = await openDeck(page, unpriced.name);
  await expect(cost).toContainText("Price unavailable · 0/6 cards priced");
  await expect(cost).not.toContainText("$0.00");
});

test("an incomplete 200 answer without a total falls back to the checks total, and a 404 answer ends the check instead of waiting forever", async ({
  page,
}) => {
  const ids = seed();
  sixCopies(ids);
  await signIn(page);
  const deck = await deckWith(page, {
    [ids.normal]: 3,
    [ids["reverse-holofoil"]]: 2,
    [ids.unspecified]: 1,
  });
  await page.route("**/api/decks/*/cost", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "cache-control": "no-store" },
      body: JSON.stringify({
        deck_id: deck.id,
        status: "incomplete",
        reason: "deadline",
        owner_revision: null,
        total_copies: null,
        currency: "USD",
      }),
    })
  );
  let cost = await openDeck(page, deck.name);
  await expect(cost).toContainText(
    "Price unavailable; coverage unavailable; 6 cards total"
  );
  await expect(cost).not.toContainText("cards priced");
  await page.unroute("**/api/decks/*/cost");

  await page.route("**/api/decks/*/cost", (route) =>
    route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ detail: { code: "DECK_NOT_FOUND" } }),
    })
  );
  cost = await openDeck(page, deck.name);
  await expect(cost).toContainText(
    "Price unavailable; coverage unavailable; 6 cards total"
  );
  await expect(cost).not.toContainText("Checking prices…");
});

// @slow (wall-clock): the stalled request waits 6 s of real time before the fallback.
test(
  "a deadline answer or a stalled request shows no numeric coverage, only the total, and the page stays usable",
  { tag: "@slow" },
  async ({ page }) => {
    const ids = seed();
    sixCopies(ids);
    await signIn(page);
    const deck = await deckWith(page, {
      [ids.normal]: 3,
      [ids["reverse-holofoil"]]: 2,
      [ids.unspecified]: 1,
    });
    await page.route("**/api/decks/*/cost", (route) =>
      route.fulfill({
        status: 504,
        contentType: "application/json",
        body: JSON.stringify({ detail: { code: "PRICE_DEADLINE" } }),
      })
    );
    let cost = await openDeck(page, deck.name);
    await expect(cost).toContainText(
      "Price unavailable; coverage unavailable; 6 cards total"
    );
    await expect(cost).not.toContainText("cards priced");
    await page.unroute("**/api/decks/*/cost");

    // A response that never comes: checks and rows render at once, only the cost waits, then falls back.
    await page.route("**/api/decks/*/cost", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      await route.continue().catch(() => undefined);
    });
    cost = await openDeck(page, deck.name);
    const checks = page.getByRole("region", {
      name: `Checks for ${deck.name}`,
    });
    await expect(checks).toContainText("6 cards");
    await expect(cost).toContainText("Checking prices…");
    await expect(
      page
        .getByRole("region", { name: `Cards in ${deck.name}` })
        .locator(".holding-grid > li")
    ).toHaveCount(3);
    await expect(cost).toContainText(
      "Price unavailable; coverage unavailable; 6 cards total",
      { timeout: 6_000 }
    );
  }
);

test("a cost for an older inventory revision is discarded and a concurrent change is priced from the new revision", async ({
  page,
}) => {
  const ids = seed();
  sixCopies(ids);
  await signIn(page);
  const deck = await deckWith(page, { [ids.normal]: 3 });
  const user = await owner();

  // 1. The first answer is held; meanwhile the Deck changes and the page reloads its checks. The held answer belongs to
  //    the old revision, so it is never shown, even with a different amount.
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let calls = 0;
  await page.route("**/api/decks/*/cost", async (route) => {
    calls += 1;
    if (calls > 1) return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    await gate;
    // By now the page has moved on (and aborted this request); whatever arrives must not be shown.
    await route
      .fulfill({
        response,
        json: { ...body, amount: "99.99", display_amount: "$99.99" },
      })
      .catch(() => undefined);
  });
  const cost = await openDeck(page, deck.name);
  await expect(cost).toContainText("Checking prices…");
  await pool.query(
    "UPDATE holding SET quantity=quantity+1, version=version+1 WHERE owner_id=$1 AND location_id=$2",
    [user, deck.id]
  );
  await pool.query(
    "UPDATE inventory_owner SET revision=revision+1 WHERE user_id=$1",
    [user]
  );
  const checks = page.getByRole("region", { name: `Checks for ${deck.name}` });
  await checks.getByRole("button", { name: "Refresh checks" }).click();
  await expect(checks).toContainText("4 cards");
  await expect(cost).toContainText("$1.00 · 4/4 cards priced");
  release();
  // flake-exempt wait-for-timeout (quiet): the released answer must never be shown, and nothing on the page marks
  // that it was dropped, so the check below follows a quiet period.
  await page.waitForTimeout(500);
  await expect(cost).not.toContainText("$99.99");
  await expect(cost).toContainText("$1.00 · 4/4 cards priced");
  await page.unroute("**/api/decks/*/cost");

  // 2. The Deck changes between the checks read and the cost capture: the answer names a newer revision, so the page
  //    reloads its checks and prices that revision instead of pairing a new total with old checks.
  let held = true;
  let resume: () => void = () => undefined;
  const paused = new Promise<void>((resolve) => (resume = resolve));
  const seen: string[] = [];
  await page.route("**/api/decks/*/cost", async (route) => {
    seen.push(route.request().url());
    if (held) {
      held = false;
      await paused;
    }
    await route.continue();
  });
  await page.goto(`${ORIGIN}/decks`);
  await page.getByRole("button", { name: deck.name, exact: true }).click();
  await openDeckTools(page);
  await expect(checks).toContainText("4 cards");
  await expect.poll(() => seen.length).toBe(1);
  await pool.query(
    "INSERT INTO holding(owner_id,location_id,edition_id,quantity,version) VALUES($1,$2,$3,2,1)",
    [user, deck.id, ids["reverse-holofoil"]]
  );
  await pool.query(
    "UPDATE inventory_owner SET revision=revision+1 WHERE user_id=$1",
    [user]
  );
  resume();
  await expect(checks).toContainText("6 cards");
  await expect(cost).toContainText("$1.86 · 6/6 cards priced");
  await expect(cost).toContainText("2 stale cards");
  expect(seen).toHaveLength(2);
});
