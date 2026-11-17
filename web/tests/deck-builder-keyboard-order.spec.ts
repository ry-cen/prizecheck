import { expect, type Page } from "@playwright/test";
import { signInAsOwner } from "./support/sign-in";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";

import { listCards } from "./support/deck-list";
import { startAsNewOwner } from "./support/owner";
import { test, artUpstream } from "./support/art-upstream";

// Editing the Deck List (#177): the deck builder's library (the browse route with the Deck's id), adding by drag and
// by tap, the copy sheet's ±1 and Swap, Delete and Backspace, one batch per edit with an Undo toast, and fast taps
// merged behind the command on its way.

const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";

type Card = {
  name: string;
  set: [id: string, name: string];
  number: string;
  category: "Pokemon" | "Trainer" | "Energy";
  types?: string[];
  trainerType?: string;
  evolveFrom?: string;
};

/** Charmander in two sets (functionally identical, so either copy swaps for the other), Pikachu, a Supporter, an Item and
 * an Energy. None of the sets is in the format rules, so every card's standing is unknown and shows "?". */
const CARDS: Record<string, Card> = {
  "edit-1": {
    name: "Charmander",
    set: ["set-a", "Alpha Set"],
    number: "4",
    category: "Pokemon",
    types: ["Fire"],
  },
  "edit-2": {
    name: "Charmander",
    set: ["set-c", "Gamma Set"],
    number: "9",
    category: "Pokemon",
    types: ["Fire"],
  },
  "edit-3": {
    name: "Pikachu",
    set: ["set-a", "Alpha Set"],
    number: "25",
    category: "Pokemon",
    types: ["Lightning"],
  },
  "edit-4": {
    name: "Professor's Research",
    set: ["set-b", "Beta Set"],
    number: "1",
    category: "Trainer",
    trainerType: "Supporter",
  },
  "edit-5": {
    name: "Ultra Ball",
    set: ["set-b", "Beta Set"],
    number: "2",
    category: "Trainer",
    trainerType: "Item",
  },
  "edit-6": {
    name: "Basic Fire Energy",
    set: ["set-b", "Beta Set"],
    number: "10",
    category: "Energy",
    types: ["Fire"],
  },
};

/** Replaces the catalog with CARDS through the real import (card kind, Trainer Type and Card Identity derived as a
 * TCGdex pull derives them). This also clears every Holding. */
function promoteCatalog() {
  execFileSync(
    ".venv/bin/python",
    [
      "-c",
      `import json, sys
import test_catalog_search as search
cards = json.loads(sys.argv[1])
class Attributed(search.SearchSource):
    def fetch(self, source_id):
        card = cards[source_id]
        record = {"id": source_id, "name": card["name"], "localId": card["number"],
                  "set": {"id": card["set"][0], "name": card["set"][1]}, "category": card["category"],
                  "image": "https://assets.tcgdex.net/en/fixture/" + source_id,
                  "variants": {"normal": True, "reverse": False}}
        for field in ("types", "trainerType", "evolveFrom"):
            if card.get(field):
                record[field] = card[field]
        if card["name"] == "Charmander":
            record["hp"] = 70
            record["attacks"] = [{"name": "Ember", "cost": ["Fire"], "damage": "30", "effect": ""}]
        if card["category"] == "Energy":
            record["energyType"] = "Normal"
        return record
search.SearchSource = Attributed
search.promote({key: card["name"] for key, card in cards.items()})`,
      JSON.stringify(CARDS),
    ],
    { env: { ...process.env, PYTHONPATH: "api:api/tests" } }
  );
}

async function query<T>(sql: string, values: unknown[] = []): Promise<T[]> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    return (await pool.query(sql, values)).rows as T[];
  } finally {
    await pool.end();
  }
}

async function signIn(page: Page) {
  // Card art comes through the art route; the API fetches it from the art stub (a 1×1 PNG).
  (await artUpstream()).reset();
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query("DELETE FROM auth_send_event");
    await startAsNewOwner(pool);
  } finally {
    await pool.end();
  }
  await signInAsOwner(page, "/collection");
  // Signed out, /collection shows the sign-in card at the same address, so wait for the shell.
  await expect(
    page.getByRole("navigation", { name: "Main views" })
  ).toBeVisible();
}

async function post(page: Page, path: string, data: object) {
  const response = await page.request.post(`${ORIGIN}${path}`, {
    headers: { origin: ORIGIN },
    data,
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

async function put(page: Page, path: string, data: object) {
  const response = await page.request.put(`${ORIGIN}${path}`, {
    headers: { origin: ORIGIN },
    data,
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

type Built = {
  deckId: string;
  owner: string;
  editions: Record<string, string>;
};

/**
 * A Deck holding 2 Alpha Set Charmander, with 1 more in a Binder (3 owned, 1 free) and 1 Professor's Research in the
 * Binder (1 owned, 1 free). `lines` puts cards on its Deck List; `target` sets its Target Format through the API.
 */
async function buildDeck(
  page: Page,
  lines: Record<string, number> = {},
  target?: "expanded"
): Promise<Built> {
  const deckId = (
    await post(page, "/api/decks", {
      name: `Edit ${randomUUID().slice(0, 6)}`,
      idempotency_key: randomUUID(),
    })
  ).location.id as string;
  const binderId = (
    await post(page, "/api/location-tree", {
      name: `Binder ${randomUUID().slice(0, 6)}`,
      parent_id: null,
      parent_version: null,
      idempotency_key: randomUUID(),
    })
  ).location.id as string;
  const editions: Record<string, string> = {};
  for (const row of await query<{ source_id: string; id: string }>(
    `SELECT p.source_id,e.id FROM catalog_edition e JOIN catalog_printing p ON p.id=e.printing_id
     WHERE p.source_id LIKE 'edit-%' AND e.descriptor->>'finish'='normal'`
  ))
    editions[row.source_id] = row.id;
  const hold = (location: string, key: string, quantity: number) =>
    post(page, "/api/holdings", {
      location_id: location,
      edition_id: editions[key],
      quantity: String(quantity),
      idempotency_key: randomUUID(),
    });
  await hold(deckId, "edit-1", 2);
  await hold(binderId, "edit-1", 1);
  await hold(binderId, "edit-4", 1);
  const [{ owner_id: owner }] = await query<{ owner_id: string }>(
    "SELECT owner_id FROM location WHERE id=$1",
    [deckId]
  );
  // Holding copies in a Deck lists them (migration 031): start from an empty Deck List, then the wanted lines.
  await query("DELETE FROM deck_list_line WHERE deck_id=$1", [deckId]);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await listCards(
      pool,
      owner,
      deckId,
      Object.fromEntries(
        Object.entries(lines).map(([key, quantity]) => [
          editions[key],
          quantity,
        ])
      )
    );
  } finally {
    await pool.end();
  }
  if (target) {
    const [{ revision }] = await query<{ revision: string }>(
      "SELECT revision FROM deck_list WHERE deck_id=$1",
      [deckId]
    );
    await put(page, `/api/decks/${deckId}/deck-list/target-format`, {
      target_format: target,
      revision: Number(revision),
      idempotency_key: randomUUID(),
    });
  }
  return { deckId, owner, editions };
}

/** The Deck List as `{source id: quantity}`, read from the database. */
async function listed(built: Built): Promise<Record<string, number>> {
  const rows = await query<{ source_id: string; quantity: string }>(
    `SELECT p.source_id,l.quantity FROM deck_list_line l JOIN catalog_edition e ON e.id=l.edition_id
     JOIN catalog_printing p ON p.id=e.printing_id WHERE l.deck_id=$1`,
    [built.deckId]
  );
  return Object.fromEntries(
    rows.map((row) => [row.source_id, Number(row.quantity)])
  );
}

const deckList = (page: Page) =>
  page.getByRole("region", { name: /^Deck(?: List| \d)/ });
const copies = (page: Page, name: string) =>
  deckList(page).getByRole("button", { name: new RegExp(`^${name},`) });
async function setup(page: Page) {
  promoteCatalog();
  await signIn(page);
  const built = await buildDeck(page, { "edit-1": 3, "edit-3": 2 });
  await page.goto(`${ORIGIN}/decks/${built.deckId}`);
  await page.getByRole("radio", { name: "Spread", exact: true }).click();
  const tab = page.getByRole("tab", { name: /^Deck / });
  if (await tab.isVisible()) await tab.click();
  return built;
}
async function order(page: Page, first: string) {
  await expect(
    deckList(page).locator("li").first().getByRole("button").first()
  ).toHaveAccessibleName(new RegExp(`^${first},`));
}
test.describe("desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });
  test("Spread: one Tab stop per line, arrows move between its copies", async ({
    page,
  }) => {
    await setup(page);
    const a = copies(page, "Charmander");
    await a.first().focus();
    await page.keyboard.press("Tab");
    await expect(
      deckList(page).getByRole("button", { name: "Remove one Charmander" })
    ).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(
      deckList(page).getByRole("button", { name: "Add one Charmander" })
    ).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(copies(page, "Pikachu").first()).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(
      deckList(page).getByRole("button", { name: "Add one Charmander" })
    ).toBeFocused();
    await a.first().focus();
    for (const [key, index] of [
      ["ArrowRight", 1],
      ["End", 2],
      ["Home", 0],
    ] as const) {
      await page.keyboard.press(key);
      await expect(a.nth(index)).toBeFocused();
    }
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("dialog", { name: "Charmander", exact: true })
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("dialog", { name: "Charmander", exact: true })
    ).toBeHidden();
  });
  test("Spread: a line keeps its place after +1 until the Deck is opened again", async ({
    page,
  }) => {
    const built = await setup(page);
    for (let i = 0; i < 2; i++) {
      await copies(page, "Pikachu").first().hover();
      await deckList(page)
        .getByRole("button", { name: "Add one Pikachu" })
        .click();
      await expect
        .poll(() => listed(built))
        .toEqual({ "edit-1": 3, "edit-3": 3 + i });
    }
    await order(page, "Charmander");
    await page.reload();
    await order(page, "Pikachu");
  });
  test("Library additions and removing then Undo preserve displayed order; reopening resets it", async ({
    page,
  }) => {
    const built = await setup(page);
    const library = page.getByRole("complementary", { name: "Library" });
    await library.getByRole("radio", { name: "All", exact: true }).click();
    await library.getByRole("button", { name: /^Pikachu, / }).click();
    const sheet = page.getByRole("dialog", { name: "Pikachu", exact: true });
    for (let i = 0; i < 2; i++) {
      await sheet
        .getByRole("button", { name: "+1, Add one Pikachu", exact: true })
        .click();
      await expect
        .poll(() => listed(built))
        .toEqual({ "edit-1": 3, "edit-3": 3 + i });
    }
    await page.keyboard.press("Escape");
    await order(page, "Charmander");
    for (let i = 0; i < 4; i++) {
      await copies(page, "Pikachu").first().focus();
      await page.keyboard.press("Delete");
      await expect
        .poll(() => listed(built))
        .toEqual(i === 3 ? { "edit-1": 3 } : { "edit-1": 3, "edit-3": 3 - i });
      await expect(copies(page, "Pikachu")).toHaveCount(3 - i);
    }
    await page
      .getByRole("region", { name: "Notifications" })
      .getByRole("button", { name: "Undo", exact: true })
      .click();
    await expect(copies(page, "Pikachu")).toHaveCount(1);
    await order(page, "Charmander");
    for (let i = 0; i < 3; i++) {
      await copies(page, "Pikachu").first().hover();
      await deckList(page)
        .getByRole("button", { name: "Add one Pikachu" })
        .click();
      await expect
        .poll(() => listed(built))
        .toEqual({ "edit-1": 3, "edit-3": 2 + i });
    }
    await order(page, "Charmander");
    await page.goto(`${ORIGIN}/decks`);
    await page.goto(`${ORIGIN}/decks/${built.deckId}`);
    await order(page, "Pikachu");
  });
});
test.describe("new Library line", () => {
  test.use({ viewport: { width: 1280, height: 800 } });
  test("a new line follows displayed lines in its group", async ({ page }) => {
    const built = await setup(page);
    const library = page.getByRole("complementary", { name: "Library" });
    await library.getByRole("radio", { name: "All", exact: true }).click();
    await library
      .getByRole("button", { name: /^Charmander, set-c 9, Gamma Set/ })
      .click();
    const sheet = page.getByRole("dialog", { name: "Charmander", exact: true });
    await sheet
      .getByRole("button", { name: "+1, Add one Charmander", exact: true })
      .click();
    await expect
      .poll(() => listed(built))
      .toEqual({ "edit-1": 3, "edit-3": 2, "edit-2": 1 });
    await page.keyboard.press("Escape");
    await expect(
      deckList(page).locator("li").last().getByRole("button").first()
    ).toHaveAccessibleName(/^Charmander, Gamma Set/);
  });
});

test.describe("phone", () => {
  test.use({
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
  });
  test("phone Spread: one tabbable copy per line", async ({ page }) => {
    await setup(page);
    await expect(
      deckList(page).locator('[data-copy-ordinal][tabindex="0"]')
    ).toHaveCount(2);
  });
  test("phone: the copy sheet's +1 keeps the line's place", async ({
    page,
  }) => {
    const built = await setup(page);
    await copies(page, "Pikachu").first().click();
    const sheet = page.getByRole("dialog", { name: "Pikachu", exact: true });
    for (let i = 0; i < 2; i++) {
      await sheet
        .getByRole("button", { name: "+1, Add one Pikachu", exact: true })
        .click();
      await expect
        .poll(() => listed(built))
        .toEqual({ "edit-1": 3, "edit-3": 3 + i });
    }
    await page.keyboard.press("Escape");
    await order(page, "Charmander");
  });
});
