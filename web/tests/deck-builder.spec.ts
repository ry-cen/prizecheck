import { test, expect, type Page } from "@playwright/test";
import { signInAsOwner } from "./support/sign-in";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { expectPageChecks } from "./support/page-check";
import { listCards } from "./support/deck-list";
import { startAsNewOwner } from "./support/owner";
import { artUpstream } from "./support/art-upstream";

// The deck builder's Deck List (#176): opening a Deck on the Decks page shows every copy, its ownership state and the
// cost, in Spread, Stacked and List, grouped by card type.

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

/** A Charizard ex line (Charmander, Charmeleon, Charizard ex), a lone Pikachu, a Supporter, an Item, an Energy, and a
 * Hisuian Arcanine line whose names have two words. */
const CARDS: Record<string, Card> = {
  "card-1": {
    name: "Charmander",
    set: ["set-a", "Alpha Set"],
    number: "4",
    category: "Pokemon",
    types: ["Fire"],
  },
  "card-2": {
    name: "Charmeleon",
    set: ["set-a", "Alpha Set"],
    number: "5",
    category: "Pokemon",
    types: ["Fire"],
    evolveFrom: "Charmander",
  },
  "card-3": {
    name: "Charizard ex",
    set: ["set-a", "Alpha Set"],
    number: "6",
    category: "Pokemon",
    types: ["Fire"],
    evolveFrom: "Charmeleon",
  },
  "card-4": {
    name: "Pikachu",
    set: ["set-a", "Alpha Set"],
    number: "25",
    category: "Pokemon",
    types: ["Lightning"],
  },
  "card-5": {
    name: "Professor's Research",
    set: ["set-b", "Beta Set"],
    number: "1",
    category: "Trainer",
    trainerType: "Supporter",
  },
  "card-6": {
    name: "Ultra Ball",
    set: ["set-b", "Beta Set"],
    number: "2",
    category: "Trainer",
    trainerType: "Item",
  },
  "card-7": {
    name: "Basic Fire Energy",
    set: ["set-b", "Beta Set"],
    number: "10",
    category: "Energy",
    types: ["Fire"],
  },
  "card-8": {
    name: "Hisuian Growlithe",
    set: ["set-a", "Alpha Set"],
    number: "70",
    category: "Pokemon",
    types: ["Fire"],
  },
  "card-9": {
    name: "Hisuian Arcanine",
    set: ["set-a", "Alpha Set"],
    number: "71",
    category: "Pokemon",
    types: ["Fire"],
    evolveFrom: "Hisuian Growlithe",
  },
};

/** Replaces the catalog with CARDS through the real import, so card kind, Trainer Type and evolves from are derived
 * the way a TCGdex pull derives them. This also clears every Holding. */
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

async function editionOf(sourceId: string): Promise<string> {
  const rows = await query<{ id: string }>(
    `SELECT e.id FROM catalog_edition e JOIN catalog_printing p ON p.id=e.printing_id
     WHERE p.source_id=$1 AND e.descriptor->>'finish'='normal'`,
    [sourceId]
  );
  return rows[0].id;
}

type Built = {
  deckId: string;
  deckName: string;
  binderName: string;
  otherName: string;
  editions: Record<string, string>;
};

/**
 * A 23-card Deck List: Charmander 3 (2 in this Deck, 1 in the Binder), Charmeleon 1 (in another Deck), Charizard ex 2
 * (not owned), Pikachu 1 (not owned), Professor's Research 4 (in this Deck), Ultra Ball 2 (1 in the Binder, 1 not
 * owned) and Basic Fire Energy 10 (in this Deck).
 */
async function buildDeck(page: Page): Promise<Built> {
  const suffix = randomUUID().slice(0, 6);
  const deckName = `Charizard ${suffix}`;
  const otherName = `Other ${suffix}`;
  const binderName = `Binder ${suffix}`;
  const deckId = (
    await post(page, "/api/decks", {
      name: deckName,
      idempotency_key: randomUUID(),
    })
  ).location.id as string;
  const otherId = (
    await post(page, "/api/decks", {
      name: otherName,
      idempotency_key: randomUUID(),
    })
  ).location.id as string;
  const binderId = (
    await post(page, "/api/location-tree", {
      name: binderName,
      parent_id: null,
      parent_version: null,
      idempotency_key: randomUUID(),
    })
  ).location.id as string;
  const editions: Record<string, string> = {};
  for (const [key, card] of Object.entries(CARDS))
    editions[card.name] = await editionOf(key);
  const hold = (location: string, name: string, quantity: number) =>
    post(page, "/api/holdings", {
      location_id: location,
      edition_id: editions[name],
      quantity: String(quantity),
      idempotency_key: randomUUID(),
    });
  await hold(deckId, "Charmander", 2);
  await hold(deckId, "Professor's Research", 4);
  await hold(deckId, "Basic Fire Energy", 10);
  await hold(binderId, "Charmander", 1);
  await hold(binderId, "Ultra Ball", 1);
  await hold(otherId, "Charmeleon", 1);
  const [{ owner_id: owner }] = await query<{ owner_id: string }>(
    "SELECT owner_id FROM location WHERE id=$1",
    [deckId]
  );
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await listCards(pool, owner, deckId, {
      [editions["Charmander"]]: 3,
      [editions["Charmeleon"]]: 1,
      [editions["Charizard ex"]]: 2,
      [editions["Pikachu"]]: 1,
      [editions["Professor's Research"]]: 4,
      [editions["Ultra Ball"]]: 2,
      [editions["Basic Fire Energy"]]: 10,
    });
  } finally {
    await pool.end();
  }
  return { deckId, deckName, binderName, otherName, editions };
}

/** Fixed cost and price answers, so the header and the List view's prices don't depend on the price cache. */
async function stubPrices(page: Page, built: Built) {
  const figure = (total: string, priced: string, display: string) => ({
    status: "priced",
    reason: null,
    total_copies: total,
    priced_copies: priced,
    stale_copies: "0",
    unknown_age_copies: "0",
    fallback_copies: "0",
    amount: display.slice(1),
    display_amount: display,
    currency: "USD",
  });
  await page.route("**/api/decks/*/cost", (route) =>
    route.fulfill({
      json: {
        deck_id: built.deckId,
        ...figure("16", "16", "$9.00"),
        owner_revision: null,
        deck_list_revision: null,
        deck_list_cost: figure("23", "20", "$12.34"),
        cost_to_complete: figure("4", "2", "$3.21"),
      },
    })
  );
  const professor = built.editions["Professor's Research"];
  await page.route("**/api/prices/editions", async (route) => {
    const ids = (route.request().postDataJSON() as { edition_ids: string[] })
      .edition_ids;
    await route.fulfill({
      json: {
        withheld: false,
        prices: ids.map((id) =>
          id === professor
            ? {
                edition_id: id,
                status: "quote",
                reason: null,
                amount: "0.25",
                display_amount: "$0.25",
                currency: "USD",
                provider_updated_at: new Date().toISOString(),
                checked_at: new Date().toISOString(),
                age: "known",
                stale: false,
                refresh: null,
                refresh_failed_at: null,
              }
            : {
                edition_id: id,
                status: "unavailable",
                reason: "not_cached",
                amount: null,
                display_amount: null,
                currency: "USD",
                provider_updated_at: null,
                checked_at: null,
                age: "unknown",
                stale: null,
                refresh: null,
                refresh_failed_at: null,
              }
        ),
      },
    });
  });
}

const tile = (page: Page, name: string, edition: string, rest: string) =>
  page.getByRole("button", {
    name: `${name}, ${edition}, ${rest}`,
    exact: true,
  });

test.describe("on a desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("opening a Deck shows every copy's state, its groups and its cost in Spread, Stacked and List", async ({
    page,
  }) => {
    promoteCatalog();
    await signIn(page);
    const built = await buildDeck(page);
    await stubPrices(page, built);

    await page.getByRole("button", { name: "Decks", exact: true }).click();
    await page
      .getByRole("navigation", { name: "Deck index" })
      .getByRole("link", { name: built.deckName, exact: true })
      .click();
    await expect(page).toHaveURL(`${ORIGIN}/decks/${built.deckId}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      built.deckName
    );
    const deckList = page.getByRole("region", { name: "Deck List" });
    await expect(deckList).toContainText("23/60");
    await expect(deckList).toContainText(
      "$12.34 deck (20/23 priced) · $3.21 to complete (2/4 priced)"
    );
    await expect(
      page.getByRole("complementary", { name: "Library" })
    ).toBeVisible();

    // Groups: Pokémon, then Trainer Types and Energy.
    await expect(deckList.getByRole("heading", { level: 3 })).toHaveText([
      "Pokémon, 7 cards",
      "Supporters, 4 cards",
      "Items, 2 cards",
      "Energy, 10 cards",
    ]);

    // Spread: one tile per copy, each with its own state.
    await expect(page.getByRole("radio", { name: "Spread" })).toBeChecked();
    const alpha = (number: string) => `Alpha Set · ${number} · Normal`;
    await expect(
      tile(page, "Charmander", alpha("4"), "copy 1 of 3: in this Deck")
    ).toBeVisible();
    await expect(
      tile(
        page,
        "Charmander",
        alpha("4"),
        `copy 3 of 3: owned elsewhere, in ${built.binderName}`
      )
    ).toBeVisible();
    await expect(
      tile(
        page,
        "Charmeleon",
        alpha("5"),
        `copy 1 of 1: owned elsewhere, in ${built.otherName} (Deck)`
      )
    ).toBeVisible();
    await expect(
      tile(page, "Charizard ex", alpha("6"), "copy 2 of 2: not owned")
    ).toBeVisible();
    await expect(
      deckList.getByRole("button", { name: /^Basic Fire Energy, / })
    ).toHaveCount(10);
    await expectPageChecks(page, "deck builder, Spread");

    // A copy's sheet says what and where it is; Escape closes it and returns focus to the copy.
    const elsewhere = tile(
      page,
      "Charmander",
      alpha("4"),
      `copy 3 of 3: owned elsewhere, in ${built.binderName}`
    );
    await elsewhere.click();
    const sheet = page.getByRole("dialog", { name: "Charmander" });
    await expect(sheet).toContainText(
      `This copy (3 of 3): owned elsewhere, in ${built.binderName}`
    );
    await expect(sheet).toContainText("3 on the Deck List");
    await expect(sheet).toContainText("2 in this Deck");
    await expect(sheet).toContainText(`1 in ${built.binderName}`);
    await expect(sheet).toContainText("0 not owned");
    await expectPageChecks(page, "deck builder, copy sheet");
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expect(elsewhere).toBeFocused();

    // Stacked: one pile per Edition with its summary.
    await page.getByRole("radio", { name: "Stacked" }).click();
    const charmander = deckList.getByRole("button", {
      name: `Charmander, ${alpha("4")}: 3 copies, 2 in this Deck, 1 owned elsewhere (${built.binderName})`,
      exact: true,
    });
    await expect(charmander).toContainText("×3 1↻");
    await expect(
      deckList.getByRole("button", { name: /^Ultra Ball, / })
    ).toContainText("×2 1↻ 1$");
    await expect(
      deckList.getByRole("button", { name: /^Charizard ex, / })
    ).toContainText("×2 2$");
    await expectPageChecks(page, "deck builder, Stacked");

    // List: quantity, Edition, ownership counts and the price of the line's copies. The arrow keys move the view.
    await page.getByRole("radio", { name: "Stacked" }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("radio", { name: "List" })).toBeChecked();
    const professor = deckList
      .getByRole("listitem")
      .filter({ hasText: "Professor's Research" });
    await expect(professor).toContainText("4 in this Deck");
    await expect(professor).toContainText("$1.00");
    await expect(
      deckList.getByRole("listitem").filter({ hasText: "Pikachu" })
    ).toContainText("No price");
    await expectPageChecks(page, "deck builder, List");

    // The header's Export dialog (#181) replaces the old panels; it passes the page check open.
    await page.getByRole("button", { name: "Export", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Export" })).toBeVisible();
    await expectPageChecks(page, "deck builder, Export open");
    await page.keyboard.press("Escape");

    // A Holdings change (Collection's, through the gateway) redraws the copy states on the next read.
    await post(page, "/api/holdings", {
      location_id: built.deckId,
      edition_id: built.editions["Charizard ex"],
      quantity: "1",
      idempotency_key: randomUUID(),
    });
    await page.reload();
    await page.getByRole("radio", { name: "Spread" }).click();
    await expect(
      tile(page, "Charizard ex", alpha("6"), "copy 1 of 2: in this Deck")
    ).toBeVisible();

    // The Decks tab goes back to the index.
    await page.getByRole("button", { name: "Decks", exact: true }).click();
    await expect(page).toHaveURL(`${ORIGIN}/decks`);
  });

  test("Pokémon share one group sorted by copies then name", async ({
    page,
  }) => {
    promoteCatalog();
    await signIn(page);
    const built = await buildDeck(page);
    // A second Deck lists Charmander and Charizard ex with no Charmeleon (a Rare Candy build), and the Hisuian pair.
    const deckName = `Rare Candy ${randomUUID().slice(0, 6)}`;
    const deckId = (
      await post(page, "/api/decks", {
        name: deckName,
        idempotency_key: randomUUID(),
      })
    ).location.id as string;
    const [{ owner_id: owner }] = await query<{ owner_id: string }>(
      "SELECT owner_id FROM location WHERE id=$1",
      [deckId]
    );
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
      await listCards(pool, owner, deckId, {
        [built.editions["Charmander"]]: 2,
        [built.editions["Charizard ex"]]: 1,
        [built.editions["Hisuian Growlithe"]]: 1,
        [built.editions["Hisuian Arcanine"]]: 1,
      });
    } finally {
      await pool.end();
    }
    await stubPrices(page, { ...built, deckId });
    await page.goto(`${ORIGIN}/decks/${deckId}`);
    const deckList = page.getByRole("region", { name: "Deck List" });
    await expect(deckList.getByRole("heading", { level: 3 })).toHaveText([
      "Pokémon, 5 cards",
    ]);
    // The region's accessible name is "Pokémon , 5 cards": Chromium pads the hidden ", " span with a space, so match
    // the group title only, as the heading check above covers the count.
    const line = page.getByRole("region", { name: /^Pokémon\b/ });
    await expect(line.getByRole("button")).toHaveCount(5);
    await expect(line.getByRole("button").first()).toHaveAccessibleName(
      /^Charmander, /
    );
    await expect(line.getByRole("button").last()).toHaveAccessibleName(
      /^Hisuian Growlithe, /
    );
  });

  test("an address for no Deck shows Deck not found, with a way back to every Deck", async ({
    page,
  }) => {
    await signIn(page);
    await page.goto(`${ORIGIN}/decks/${randomUUID()}`);
    await expect(
      page.getByRole("heading", { level: 1, name: "Deck not found" })
    ).toBeVisible();
    await page.getByRole("link", { name: "All Decks" }).click();
    await expect(page).toHaveURL(`${ORIGIN}/decks`);
    await expect(
      page.getByRole("heading", { level: 1, name: "Decks" })
    ).toBeVisible();
  });
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

  test("the builder opens on Library, the Deck tab carries the live count, and the Deck List opens Stacked", async ({
    page,
  }) => {
    promoteCatalog();
    await signIn(page);
    const built = await buildDeck(page);
    await stubPrices(page, built);
    await page.goto(`${ORIGIN}/decks/${built.deckId}`);

    const library = page.getByRole("tab", { name: "Library" });
    const deck = page.getByRole("tab", { name: "Deck 23/60" });
    await expect(library).toHaveAttribute("aria-selected", "true");
    // The library (#177) fills the Library tab.
    await expect(
      page
        .getByRole("tabpanel")
        .getByRole("searchbox", { name: "Search the library" })
    ).toBeVisible();
    await expectPageChecks(page, "phone deck builder, Library");

    await deck.tap();
    await expect(deck).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("radio", { name: "Stacked" })).toBeChecked();
    const pile = page.getByRole("button", { name: /^Charmander, / });
    await expect(pile).toContainText("×3 1↻");
    await expectPageChecks(page, "phone deck builder, Stacked");

    await pile.tap();
    const sheet = page.getByRole("dialog", { name: "Charmander" });
    await expect(sheet).toContainText("1 owned elsewhere");
    await expectPageChecks(page, "phone deck builder, copy sheet");
    await sheet.getByRole("button", { name: "Close card" }).tap();
    await expect(sheet).toBeHidden();

    await page.getByRole("radio", { name: "Spread" }).tap();
    await expect(
      page.getByRole("button", { name: /^Basic Fire Energy, / })
    ).toHaveCount(10);
    await expectPageChecks(page, "phone deck builder, Spread");

    await page.getByRole("radio", { name: "List" }).tap();
    await expect(
      page.getByRole("listitem").filter({ hasText: "Professor's Research" })
    ).toContainText("$1.00");
    await expectPageChecks(page, "phone deck builder, List");

    // The old panels are gone (#181): the page header holds Export, Publish and Delete, and the page still passes.
    for (const name of ["Export", "Delete Deck"])
      await expect(
        page.getByRole("button", { name, exact: true })
      ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^Publish/ }).first()
    ).toBeVisible();
    await expect(
      page.getByText("Holdings, publishing and exports", { exact: true })
    ).toHaveCount(0);
    await expectPageChecks(page, "phone deck builder header actions");
  });
});
