import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { Pool } from "pg";
import { exemptFromPublishGate } from "./support/publish-gate";
import { listCards, raiseLine } from "./support/deck-list";

// Ticket 12: the Estimated Deck Cost on a Published Deck page, read by an anonymous visitor in a second browser context
// (no cookie) against the real stack. Quotes are checked under an hour ago, so nothing waits for a runner.
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
  const path = `${process.env.TMPDIR || "/tmp"}/published-cost-${randomUUID()}.json`;
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

/** A Deck whose Deck List is `{edition: quantity}` and which holds none of those cards, written straight to PostgreSQL. */
async function deckWith(page: Page, quantities: Record<string, number>) {
  const name = `Cost ${randomUUID().slice(0, 8)}`;
  const created = await page.request.post(`${ORIGIN}/api/decks`, {
    headers: { origin: ORIGIN },
    data: { name, idempotency_key: randomUUID() },
  });
  expect(created.status()).toBe(201);
  const id = (await created.json()).location.id as string;
  await listCards(pool, await owner(), id, quantities);
  return { id, name };
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

/** Publish (POST), republish (PUT) or revoke (DELETE) through the owner's session; returns the JSON. */
async function publication(
  page: Page,
  method: "POST" | "PUT" | "DELETE",
  deckId: string
) {
  if (method !== "DELETE") exemptFromPublishGate(deckId); // a small Deck List, not legal in any Format
  const response = await page.request.fetch(
    `${ORIGIN}/api/decks/${deckId}/publication`,
    {
      method,
      headers: { origin: ORIGIN },
      data:
        method === "DELETE"
          ? { idempotency_key: randomUUID() }
          : { title: "Priced public deck", idempotency_key: randomUUID() },
    }
  );
  expect(response.status()).toBe(200);
  return response.json();
}
const bump = async () =>
  pool.query(
    "UPDATE inventory_owner SET revision=revision+1 WHERE user_id=$1",
    [await owner()]
  );

test("an anonymous visitor sees $1.61 and 5/6 for the frozen snapshot, which stays readable while the price is checked and ignores private edits", async ({
  page,
  browser,
}) => {
  const ids = seed();
  sixCopies(ids);
  await signIn(page);
  const deck = await deckWith(page, {
    [ids.normal]: 3,
    [ids["reverse-holofoil"]]: 2,
    [ids.unspecified]: 1,
  });
  const token = (await publication(page, "POST", deck.id)).token as string;
  const anonymous = await browser.newContext();
  const visitor = await anonymous.newPage();
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const pattern = `**/api/public/decks/${token}/versions/1/cost`;
  await visitor.route(pattern, async (route) => {
    await released;
    await route.continue();
  });
  await visitor.goto(`${ORIGIN}/published/${token}`);
  await expect(visitor.getByRole("main")).toContainText(
    "6 cards · 54 cards short of 60"
  );
  const cost = visitor.getByRole("region", { name: "Estimated Deck Cost" });
  await expect(cost).toContainText("Checking prices…");
  release();
  await expect(cost).toContainText("$1.61 · 5/6 cards priced");
  await expect(cost).toContainText(
    "Incomplete subtotal: 1 card without a price"
  );
  await expect(cost).toContainText("2 stale cards (price over 48 hours old)");
  await expect(cost).toContainText("Excludes shipping and taxes");
  // A private edit after publishing changes nothing the visitor sees.
  await raiseLine(pool, deck.id, ids.normal, 4);
  await bump();
  await visitor.unroute(pattern);
  await visitor.reload();
  await expect(cost).toContainText("$1.61 · 5/6 cards priced");
  await anonymous.close();
});

test("a cost answer held across a republish is discarded and the page prices the new snapshot", async ({
  page,
  browser,
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
  const deck = await deckWith(page, { [ids.normal]: 1 });
  const token = (await publication(page, "POST", deck.id)).token as string;
  const anonymous = await browser.newContext();
  const visitor = await anonymous.newPage();
  let republished = false;
  await visitor.route("**/versions/1/cost", async (route) => {
    if (!republished) {
      republished = true;
      await raiseLine(pool, deck.id, ids.normal, 1);
      await bump();
      await publication(page, "PUT", deck.id);
    }
    await route.continue();
  });
  const stale = visitor.waitForResponse((r) =>
    r.url().includes("/versions/1/cost")
  );
  await visitor.goto(`${ORIGIN}/published/${token}`);
  expect((await stale).status()).toBe(409);
  await expect(visitor.getByRole("main")).toContainText("Snapshot version 2");
  const cost = visitor.getByRole("region", { name: "Estimated Deck Cost" });
  await expect(cost).toContainText("$0.50 · 2/2 cards priced");
  // An answer for another version is never shown.
  await visitor.route("**/versions/2/cost", (route) =>
    route.fulfill({
      status: 200,
      json: {
        version: 1,
        digest: null,
        status: "priced",
        reason: null,
        total_copies: "2",
        priced_copies: "2",
        stale_copies: "0",
        unknown_age_copies: "0",
        fallback_copies: "0",
        amount: "9",
        display_amount: "$9.00",
        currency: "USD",
      },
    })
  );
  await visitor.reload();
  await expect(cost).toContainText(
    "Price unavailable; coverage unavailable; 2 cards total"
  );
  await expect(cost).not.toContainText("$9.00");
  await anonymous.close();
});
