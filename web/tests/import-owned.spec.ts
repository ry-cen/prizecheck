import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { expectPageChecks } from "./support/page-check";
import { startAsNewOwner } from "./support/owner";
import { signInAsOwner } from "./support/sign-in";
import { expectTouchTarget } from "./support/touch-target";
import { artUpstream } from "./support/art-upstream";

// Owned cards in the import (#214). The review's side column holds the owned-cards setting: Use cards I own (the
// default) also uses owned copies of other printings of a card, Exact printings only the printing each line names.
// Switching recounts every line and the totals, and the choice is remembered on this device. The catalog is
// api/tests/deck_import_fixtures.py's OWNED_CARDS: Iono PAL 185 (Normal, Reverse Holo) and Iono PAL 254 (Holo) are one
// Reprint Group. No prices are stored, so new copies take the first Edition in catalog order.

const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function seedCatalog() {
  execFileSync(
    ".venv/bin/python",
    [
      "-c",
      "from deck_import_fixtures import seed_import_owned_catalog\nseed_import_owned_catalog()",
    ],
    { env: { ...process.env, PYTHONPATH: "api:api/tests" } }
  );
}

async function edition(sourceId: string, finish: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    "SELECT e.id FROM catalog_edition e JOIN catalog_printing p ON p.id=e.printing_id WHERE p.source_id=$1 AND e.descriptor->>'finish'=$2",
    [sourceId, finish]
  );
  return rows[0].id;
}

async function signIn(page: Page) {
  // Card art comes through the art route; the API fetches it from the art stub (a 1×1 PNG).
  (await artUpstream()).reset();
  await pool.query("DELETE FROM auth_send_event");
  await startAsNewOwner(pool);
  await signInAsOwner(page, "/decks");
  await expect(
    page.getByRole("heading", { name: "Decks", level: 1, exact: true })
  ).toBeVisible();
}

async function api(page: Page, path: string, data: object) {
  const response = await page.request.fetch(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { origin: ORIGIN },
    data,
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

/** The owner's Binder with 1 Iono PAL 254 Holo, and a Deck holding 2 Iono PAL 185 Reverse Holo for its own list. */
async function collection(page: Page) {
  const suffix = randomUUID().slice(0, 6);
  const binder = await api(page, "/api/location-tree", {
    name: "Binder",
    parent_id: null,
    parent_version: null,
    idempotency_key: randomUUID(),
  });
  const charizard = `Charizard ex ${suffix}`;
  const deck = await api(page, "/api/decks", {
    name: charizard,
    idempotency_key: randomUUID(),
  });
  const hold = (location: string, editionId: string, quantity: number) =>
    api(page, "/api/holdings", {
      location_id: location,
      edition_id: editionId,
      quantity: String(quantity),
      idempotency_key: randomUUID(),
    });
  await hold(binder.location.id, await edition("sv02-254", "holo"), 1);
  // Copies arriving in a Deck list them (migration 031): they are that Deck's own.
  await hold(deck.location.id, await edition("sv02-185", "reverse"), 2);
  return charizard;
}

const lineItem = (page: Page, text: string) =>
  page.getByRole("listitem").filter({ hasText: text });

const chip = (page: Page, name: string) =>
  page
    .getByRole("group", { name: "Show lines" })
    .getByRole("button", { name: new RegExp(`^${name} \\d+$`) });

const setting = (page: Page) =>
  page.getByRole("radiogroup", { name: "Owned cards" });

async function review(page: Page, text: string) {
  await page.goto(`${ORIGIN}/decks/import`);
  await page.getByLabel("Decklist").fill(text);
  await page.getByLabel("Deck name").fill(`Iono ${randomUUID().slice(0, 8)}`);
  // The paste screen has no owned-cards setting; only the review's side column does.
  await expect(
    page.getByRole("radiogroup", { name: "Owned cards" })
  ).toHaveCount(0);
  await page.getByRole("button", { name: /^Review \d+ lines?$/ }).click();
  await expect(
    page.getByRole("heading", { name: "Check the list", level: 1 })
  ).toBeVisible();
}

test.afterAll(async () => {
  await pool.end();
});

test.describe("on a desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("Use cards I own is the default, switching to Exact printings recounts every line and the totals, the choice is remembered on this device, and Create Deck saves the owned copies' Editions", async ({
    page,
  }) => {
    seedCatalog();
    await signIn(page);
    const charizard = await collection(page);

    await review(page, "4 Iono PAL 185\n1 Nest Ball SVI 181\n");
    // The review's side column holds the setting, its explainer and the counting it follows.
    const summary = page.getByRole("complementary", {
      name: "Import summary",
    });
    const owned = setting(page).getByRole("radio", { name: "Use cards I own" });
    const exact = setting(page).getByRole("radio", { name: "Exact printings" });
    await expect(owned).toHaveAttribute("aria-checked", "true");
    await expect(summary).toContainText(
      "Also uses cards you own in other printings of the same card."
    );
    await expect(summary).toContainText(
      "Copies are counted as your Want List counts them: Every Deck built at once."
    );

    const iono = lineItem(page, "4 Iono PAL 185");
    await expect(iono).toContainText(
      "Used 1 Iono PAL 254 · Holo you own · Binder"
    );
    await expect(iono).toContainText("3 PAL 185 · no Edition priced");
    await expect(iono).toContainText(
      `2 in ${charizard} stay there: they're that Deck's own.`
    );
    await expect(summary).toContainText(/You own\s*1 card/);
    await expect(summary).toContainText(/To get\s*4 cards · 4 unpriced/);
    await expect(chip(page, "Changed")).toHaveText("Changed 1");

    await exact.click();
    await expect(exact).toHaveAttribute("aria-checked", "true");
    await expect(iono).toContainText("4 PAL 185 · no Edition priced");
    await expect(iono).not.toContainText("Used 1 Iono PAL 254");
    await expect(summary).toContainText(/You own\s*0 cards/);
    await expect(summary).toContainText(/To get\s*5 cards · 5 unpriced/);
    await expect(summary).toContainText(
      "Uses cards you own only in the printing each line names, in any finish."
    );
    await expect(chip(page, "Changed")).toHaveText("Changed 0");
    await expectPageChecks(page, "import review under Exact printings");

    // A reload on this device keeps Exact printings for the next review.
    await page.reload();
    await review(page, "4 Iono PAL 185\n1 Nest Ball SVI 181\n");
    await expect(exact).toHaveAttribute("aria-checked", "true");
    await expect(lineItem(page, "4 Iono PAL 185")).toContainText(
      "4 PAL 185 · no Edition priced"
    );

    await owned.click();
    await expect(lineItem(page, "4 Iono PAL 185")).toContainText(
      "Used 1 Iono PAL 254 · Holo you own · Binder"
    );
    await expect(
      page.getByRole("region", { name: "Save" }).getByRole("status").first()
    ).toHaveText("Ready · 5 cards · 3 Deck List lines");
    await page.getByRole("button", { name: "Create Deck" }).click();
    await expect(page).toHaveURL(/\/decks\/[0-9a-f-]{36}$/);
    const id = page.url().split("/").pop()!;
    const response = await page.request.get(`${ORIGIN}/api/decks/${id}`);
    const deck = (await response.json()) as {
      deck_list: { lines: { edition_id: string; quantity: string }[] };
    };
    const quantities = Object.fromEntries(
      deck.deck_list.lines.map((l) => [l.edition_id, l.quantity])
    );
    expect(quantities[await edition("sv02-254", "holo")]).toBe("1");
    expect(quantities[await edition("sv02-185", "normal")]).toBe("3");
  });
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

  test("the owned-cards setting sits in the summary above the list with 44 px choices", async ({
    page,
  }) => {
    seedCatalog();
    await signIn(page);
    await collection(page);
    await review(page, "4 Iono PAL 185\n");
    const exact = setting(page).getByRole("radio", { name: "Exact printings" });
    await expectTouchTarget(exact);
    await expectTouchTarget(
      setting(page).getByRole("radio", { name: "Use cards I own" })
    );
    await exact.tap();
    await expect(lineItem(page, "4 Iono PAL 185")).toContainText(
      "4 PAL 185 · no Edition priced"
    );
    await expectPageChecks(page, "import review summary on a phone");
  });
});
