import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { openExport } from "./support/deck-builder";

const OWNER_EMAIL = process.env.OWNER_EMAIL || "owner@example.test";
const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const BASE = "https://www.tcgplayer.com/massentry?productline=Pokemon&c=";

const lastOtp = () =>
  JSON.parse(
    readFileSync(process.env.MAIL_FILE!, "utf8").trim().split("\n").at(-1)!
  ).otp as string;

/**
 * `cards` Furret-like Printings (Normal and Reverse Editions each). `mapped` gives card number -> product,
 * established by maintainer `correct` decisions; nothing else is ever verified and no rule is activated.
 */
function seed(cards: number, mapped: Record<number, number>) {
  execFileSync(
    ".venv/bin/python",
    [
      "-c",
      `import json
from app import public_catalog
public_catalog.publish_catalog_best_effort = lambda *a, **k: True
from app.main import connect
from test_catalog_metadata import Records
from test_catalog_reconciliation import run
from test_catalog_targets import card, metadata
from test_metadata_reviews import decide, evidence, seed_users
seed_users()
run(Records(*[card(i) for i in range(1, ${cards} + 1)]))
for number, product in json.loads('${JSON.stringify(mapped)}').items():
    edition = metadata(f"meta-{number}")[1]["normal"]["id"]
    response = decide(evidence("editions", str(edition)), "correct", {"product_id": product, "quote_variant": None})
    assert response.status_code == 200, response.text
with connect() as conn:
    conn.execute("DELETE FROM owner_binding")`,
    ],
    { env: { ...process.env, PYTHONPATH: "api:api/tests" } }
  );
}

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

const editionOf = async (number: number) =>
  (
    await pool.query(
      `SELECT e.id FROM catalog_edition e JOIN catalog_printing p ON p.id=e.printing_id
       WHERE p.source_id=$1 AND e.descriptor->>'type'='normal'`,
      [`meta-${number}`]
    )
  ).rows[0].id as string;

async function createDeck(page: Page) {
  const name = `Mass ${randomUUID().slice(0, 8)}`;
  const created = await page.request.post(`${ORIGIN}/api/decks`, {
    headers: { origin: ORIGIN },
    data: { name, idempotency_key: randomUUID() },
  });
  expect(created.status()).toBe(201);
  return { name, id: (await created.json()).location.id as string };
}

async function put(page: Page, deck: string, number: number, quantity: number) {
  const added = await page.request.post(`${ORIGIN}/api/holdings`, {
    headers: { origin: ORIGIN },
    data: {
      location_id: deck,
      edition_id: await editionOf(number),
      quantity: String(quantity),
      idempotency_key: randomUUID(),
    },
  });
  expect(added.status()).toBe(200);
}

/**
 * One copy of each card's Normal Edition stored in the Deck by SQL, then one owner revision bump, as live-export.spec.ts
 * makeDeck does. The HTTP Add path has its own browser and API tests; the export under test only reads the Deck.
 */
async function putAll(deck: string, numbers: number[]) {
  const owner = (
    await pool.query('SELECT id FROM "user" WHERE email=$1', [OWNER_EMAIL])
  ).rows[0].id as string;
  for (const number of numbers)
    await pool.query(
      "INSERT INTO holding(owner_id,location_id,edition_id,quantity,version) VALUES($1,$2,$3,1,1)",
      [owner, deck, await editionOf(number)]
    );
  await pool.query(
    "UPDATE inventory_owner SET revision=revision+1 WHERE user_id=$1",
    [owner]
  );
}

/** Opens the Deck from the Decks index, then its Mass Entry export of the whole Deck List (the deck builder's Export
 * dialog, #181). These Decks hold every card they list, so the cards-not-owned choice would be empty. */
async function openDeck(page: Page, name: string) {
  await page.reload();
  await page.getByRole("button", { name: "Decks", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Deck index" })
    .getByRole("link", { name, exact: true })
    .click();
  return openExport(page, "mass", "deck_list");
}

test.beforeEach(async ({ context }) => {
  // Real TCGplayer is never contacted; the handler records what a browser would have requested.
  await context.route("https://www.tcgplayer.com/**", (route) => route.abort());
});
test.afterAll(async () => {
  await pool.end();
});

test("an all-mapped Deck opens TCGplayer only after the explanation, in a new tab with the generated link", async ({
  page,
  context,
}) => {
  seed(2, { 1: 5001, 2: 5002 });
  await signIn(page);
  const deck = await createDeck(page);
  await put(page, deck.id, 1, 4);
  await put(page, deck.id, 2, 2);
  const requested: string[] = [];
  await context.route("https://www.tcgplayer.com/**", (route) => {
    requested.push(route.request().url());
    return route.abort();
  });
  const region = await openDeck(page, deck.name);
  await region
    .getByRole("button", { name: "Prepare TCGplayer export" })
    .click();
  await expect(region).toContainText("Every card has a verified TCGplayer");
  expect(requested).toEqual([]); // preparing never navigates
  await region.getByRole("button", { name: "Open in TCGplayer" }).click();
  const dialog = page.getByRole("dialog", {
    name: "Before you open TCGplayer",
  });
  await expect(dialog).toContainText(
    "does not guarantee the finish or condition"
  );
  await expect(dialog).toContainText("Review every selection");
  await expect(dialog).toContainText("Nothing is purchased");
  expect(requested).toEqual([]);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);

  await region.getByRole("button", { name: "Open in TCGplayer" }).click();
  const link = page.getByRole("link", { name: "Continue to TCGplayer" });
  const expected = BASE + "4-5001%7C%7C2-5002";
  await expect(link).toHaveAttribute("href", expected);
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  const popup = context.waitForEvent("page");
  await link.click();
  await popup;
  await expect.poll(() => requested).toEqual([expected]);
  expect(requested[0]).toBe(
    (
      await (
        await page.request.get(
          `${ORIGIN}/api/decks/${deck.id}/exports/tcgplayer?scope=deck_list`
        )
      ).json()
    ).url
  );
  await expect(region).not.toContainText(/checkout|cart|total price/i);
});

test("a missing or quarantined mapping gives complete labelled text, copy reports success only after the write, and denial keeps selectable text", async ({
  page,
  context,
}) => {
  seed(3, { 1: 5001, 2: 5002 });
  await pool.query(
    `UPDATE catalog_edition_metadata SET mapping_state='quarantined',mapping_reason='candidate_changed'
     WHERE edition_id=$1`,
    [await editionOf(2)]
  );
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: ORIGIN,
  });
  await signIn(page);
  const deck = await createDeck(page);
  await put(page, deck.id, 1, 3);
  await put(page, deck.id, 2, 2);
  await put(page, deck.id, 3, 1); // never verified
  const region = await openDeck(page, deck.name);
  await region
    .getByRole("button", { name: "Prepare TCGplayer export" })
    .click();
  await expect(region).toContainText("No TCGplayer link is offered");
  await expect(region).toContainText("Less specific: 3 of 3 rows");
  await expect(region).toContainText("different Printing");
  await expect(region).toContainText("Basic deck checks only"); // existing disclaimer
  await expect(region).toContainText("6 cards, not 60"); // non-60 warning, not a refusal
  await expect(
    region.getByRole("button", { name: "Open in TCGplayer" })
  ).toHaveCount(0);
  const text = region.getByLabel("TCGplayer Mass Entry text");
  await expect(text).toHaveText(/^(\d Furret\n){2}\d Furret$/);
  const shown = (await text.textContent())!;
  expect(shown.split("\n").sort()).toEqual([
    "1 Furret",
    "2 Furret",
    "3 Furret",
  ]);

  await region.getByRole("button", { name: "Copy text" }).click();
  await expect(region).toContainText("Copied to clipboard.");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(shown);

  await page.evaluate(() => {
    navigator.clipboard.writeText = () => Promise.reject(new Error("denied"));
  });
  await region.getByRole("button", { name: "Copy text" }).click();
  await expect(region).toContainText("Copy failed");
  await expect(region).not.toContainText("Copied to clipboard.");
  await expect(region.getByLabel("TCGplayer Mass Entry text")).toHaveValue(
    shown
  );
});

test("an empty Deck is disabled with No cards", async ({ page }) => {
  seed(1, {});
  await signIn(page);
  const deck = await createDeck(page);
  const region = await openDeck(page, deck.name);
  await expect(region).toContainText("No cards");
  await expect(
    region.getByRole("button", { name: "Prepare TCGplayer export" })
  ).toBeDisabled();
});

// @slow (capacity): exports a multi-page Deck.
test(
  "every page of a large Deck is exported and an inventory change discards the result",
  { tag: "@slow" },
  async ({ page }) => {
    seed(51, {});
    await signIn(page);
    const deck = await createDeck(page);
    await putAll(
      deck.id,
      Array.from({ length: 51 }, (_, index) => index + 1)
    );
    const region = await openDeck(page, deck.name);
    await region
      .getByRole("button", { name: "Prepare TCGplayer export" })
      .click();
    const text = region.getByLabel("TCGplayer Mass Entry text");
    await expect(text).toContainText("1 Furret");
    expect(((await text.textContent()) ?? "").split("\n")).toHaveLength(51);

    // Another tab-equivalent change: the Deck's revision moves, so the next export says so and the page reads the
    // Deck again; the old export never stays.
    await put(page, deck.id, 1, 1);
    await region
      .getByRole("button", { name: "Prepare TCGplayer export" })
      .click();
    await expect(region).toContainText("Deck changed; export again");
    await expect(region.getByLabel("TCGplayer Mass Entry text")).toHaveCount(0);
    await region
      .getByRole("button", { name: "Prepare TCGplayer export" })
      .click();
    await expect(region.getByLabel("TCGplayer Mass Entry text")).toContainText(
      "2 Furret"
    );
  }
);

// @slow (capacity): 130 mapped Printings, each a maintainer decision.
test(
  "a link over 2,000 bytes is withheld and the complete text is offered",
  { tag: "@slow" },
  async ({ page }) => {
    test.setTimeout(240_000); // 130 maintainer decisions
    const cards = 130;
    const mapped = Object.fromEntries(
      Array.from({ length: cards }, (_, index) => [
        index + 1,
        2_000_000_000 - index,
      ])
    );
    seed(cards, mapped);
    await signIn(page);
    const deck = await createDeck(page);
    await putAll(
      deck.id,
      Array.from({ length: cards }, (_, index) => index + 1)
    );
    const region = await openDeck(page, deck.name);
    await region
      .getByRole("button", { name: "Prepare TCGplayer export" })
      .click();
    await expect(region).toContainText("longer than 2,000 characters");
    await expect(
      region.getByRole("button", { name: "Open in TCGplayer" })
    ).toHaveCount(0);
    const api = await (
      await page.request.get(
        `${ORIGIN}/api/decks/${deck.id}/exports/tcgplayer?scope=deck_list`
      )
    ).json();
    expect(api).toMatchObject({
      status: "text",
      fallback_reason: "encoded_length",
      url: null,
    });
    expect(api.lines).toHaveLength(cards);
  }
);
