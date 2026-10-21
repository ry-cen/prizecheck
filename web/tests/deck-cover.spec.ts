import { test, expect, type Page } from "@playwright/test";
import { signInAsOwner } from "./support/sign-in";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { buildLegalDeck, promoteLegalCatalog } from "./support/legal-deck";
import { expectPageChecks } from "./support/page-check";
import { expectTouchTarget } from "./support/touch-target";
import { startAsNewOwner } from "./support/owner";

// Set as cover in a copy's sheet in the deck builder (#291). The cards come through the real catalog import
// (support/legal-deck.ts): Bulbasaur x1, Rare Candy x4, Switch x4 and 51 Basic Grass Energy, so the automatic cover
// is Basic Grass Energy until a card is picked.

const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";

async function signIn(page: Page) {
  // Card artwork never reaches the network.
  await page.route(/^https:\/\/assets\.tcgdex\.net\//, (route) =>
    route.abort()
  );
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query("DELETE FROM auth_send_event");
    await startAsNewOwner(pool);
  } finally {
    await pool.end();
  }
  await signInAsOwner(page, "/collection");
  await expect(
    page.getByRole("navigation", { name: "Main views" })
  ).toBeVisible();
}

/** Fixed cost answers, so nothing waits on the price cache: every Deck costs $12.34 to complete, 57 of 57 priced. */
async function stubCost(page: Page) {
  const figure = (amount: string | null, copies: string) => ({
    status: amount === null ? "empty" : "priced",
    reason: null,
    total_copies: copies,
    priced_copies: copies,
    stale_copies: "0",
    unknown_age_copies: "0",
    fallback_copies: "0",
    amount,
    display_amount: amount === null ? "$0.00" : `$${amount}`,
    currency: "USD",
  });
  await page.route("**/api/decks/*/cost", (route) => {
    const deckId = new URL(route.request().url()).pathname.split("/")[3];
    return route.fulfill({
      json: {
        deck_id: deckId,
        ...figure("15.00", "60"),
        owner_revision: null,
        deck_list_revision: null,
        deck_list_cost: figure("15.00", "60"),
        cost_to_complete: figure("12.34", "57"),
      },
    });
  });
}

const copyButton = (page: Page, name: string, of: number) =>
  page
    .getByRole("region", { name: "Deck List" })
    .getByRole("button", { name: new RegExp(`^${name}, .*, copy 1 of ${of}:`) })
    .first();

/** The Deck's cover Edition as My Decks' index gives it. */
async function indexCover(page: Page, deckId: string) {
  const response = await page.request.get(`${ORIGIN}/api/decks`);
  expect(response.status()).toBe(200);
  const decks = (await response.json()).decks as {
    id: string;
    cover?: { edition_id: string } | null;
  }[];
  return decks.find((deck) => deck.id === deckId)?.cover?.edition_id ?? null;
}

async function deckListRevision(page: Page, deckId: string) {
  const response = await page.request.get(`${ORIGIN}/api/decks/${deckId}`);
  expect(response.status()).toBe(200);
  return (await response.json()).deck_list.revision as number;
}

async function setCoverByApi(
  page: Page,
  deckId: string,
  edition: string | null,
  expected: string | null
) {
  const response = await page.request.put(
    `${ORIGIN}/api/decks/${deckId}/cover`,
    {
      headers: { origin: ORIGIN },
      data: {
        edition_id: edition,
        expected_edition_id: expected,
        idempotency_key: randomUUID(),
      },
    }
  );
  expect(response.status()).toBe(200);
}

test.describe("on a desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("Set as cover in a copy's sheet picks the Deck's cover, and Remove as cover on that card clears it", async ({
    page,
  }) => {
    promoteLegalCatalog();
    await signIn(page);
    await stubCost(page);
    const { deckId, editions } = await buildLegalDeck(page, "Cover");
    const revision = await deckListRevision(page, deckId);

    await page.goto(`${ORIGIN}/decks/${deckId}`);
    await copyButton(page, "Switch", 4).click();
    const sheet = page.getByRole("dialog", { name: "Switch" });
    await sheet.getByRole("button", { name: "Set as cover" }).click();
    await expect(
      sheet
        .getByRole("status")
        .filter({ hasText: "This card is now the Deck's cover." })
    ).toBeVisible();
    await expect(
      sheet.getByRole("button", { name: "Remove as cover" })
    ).toBeFocused();
    await expect(sheet).toContainText("This is the Deck's cover on My Decks.");
    await expect.poll(() => indexCover(page, deckId)).toBe(editions.switch);
    await expect.poll(() => deckListRevision(page, deckId)).toBe(revision);
    await expectPageChecks(page, "deck builder, copy sheet, cover");

    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    await copyButton(page, "Bulbasaur", 1).click();
    const other = page.getByRole("dialog", { name: "Bulbasaur" });
    await expect(
      other.getByRole("button", { name: "Set as cover" })
    ).toBeVisible();
    await expect(other).not.toContainText("This is the Deck's cover");
    await page.keyboard.press("Escape");
    await expect(other).toHaveCount(0);

    await copyButton(page, "Switch", 4).click();
    await sheet.getByRole("button", { name: "Remove as cover" }).click();
    await expect(
      sheet
        .getByRole("status")
        .filter({ hasText: "This card is no longer the Deck's cover." })
    ).toBeVisible();
    await expect(
      sheet.getByRole("button", { name: "Set as cover" })
    ).toBeVisible();
    await expect.poll(() => indexCover(page, deckId)).toBe(editions.energy);
  });

  test("A cover changed somewhere else is re-read and the sheet says so", async ({
    page,
  }) => {
    promoteLegalCatalog();
    await signIn(page);
    await stubCost(page);
    const { deckId, editions } = await buildLegalDeck(page, "Cover");

    await page.goto(`${ORIGIN}/decks/${deckId}`);
    await copyButton(page, "Switch", 4).click();
    const sheet = page.getByRole("dialog", { name: "Switch" });
    await expect(
      sheet.getByRole("button", { name: "Set as cover" })
    ).toBeVisible();
    await setCoverByApi(page, deckId, editions.bulbasaur, null);

    await sheet.getByRole("button", { name: "Set as cover" }).click();
    await expect(
      sheet
        .getByRole("status")
        .filter({ hasText: /^This Deck's cover changed/ })
    ).toHaveText(
      "This Deck's cover changed somewhere else, so nothing changed. It's up to date now: try again."
    );
    await sheet.getByRole("button", { name: "Set as cover" }).click();
    await expect(
      sheet.getByRole("status").filter({ hasText: /^This card is now/ })
    ).toHaveText("This card is now the Deck's cover.");
    await expect.poll(() => indexCover(page, deckId)).toBe(editions.switch);
  });
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

  test("Set as cover is a 44 px control in a phone's copy sheet", async ({
    page,
  }) => {
    promoteLegalCatalog();
    await signIn(page);
    await stubCost(page);
    const { deckId } = await buildLegalDeck(page, "Cover");

    await page.goto(`${ORIGIN}/decks/${deckId}`);
    await page.getByRole("tab", { name: /^Deck/ }).tap();
    await page
      .getByRole("radiogroup", { name: "Deck List view" })
      .getByRole("radio", { name: "Spread" })
      .tap();
    await page
      .getByRole("tabpanel")
      .getByRole("button", { name: /^Switch, .*, copy 1 of 4:/ })
      .first()
      .tap();
    const sheet = page.getByRole("dialog", { name: "Switch" });
    await expectTouchTarget(
      sheet.getByRole("button", { name: "Set as cover" })
    );
    await expectPageChecks(page, "deck builder, copy sheet, cover, phone");
  });
});
