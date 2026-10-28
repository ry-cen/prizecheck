import { test, expect, type Locator, type Page } from "@playwright/test";
import { signInAsOwner } from "./support/sign-in";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { expectPageChecks } from "./support/page-check";
import { listCards, raiseLine } from "./support/deck-list";
import { startAsNewOwner } from "./support/owner";
import { artUpstream } from "./support/art-upstream";

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

/** Charmander in two sets (one Card Identity, so either copy swaps for the other), Pikachu, a Supporter, an Item and
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

/** Counts the batch Deck List commands the page sends. */
function countChanges(page: Page) {
  const sent: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().endsWith("/deck-list/changes")
    )
      sent.push(request.postData() ?? "");
  });
  return sent;
}

/** A mouse drag from the centre of one element to the centre of another, in steps past the 6 px threshold. */
async function drag(page: Page, from: Locator, to: Locator, escape = false) {
  const start = (await from.boundingBox())!;
  const end = (await to.boundingBox())!;
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    start.x + start.width / 2 + 10,
    start.y + start.height / 2 + 10,
    { steps: 3 }
  );
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, {
    steps: 8,
  });
  if (escape) await page.keyboard.press("Escape");
  await page.mouse.up();
}

const library = (page: Page) =>
  page.getByRole("complementary", { name: "Library" });
const deckList = (page: Page) =>
  page.getByRole("region", { name: "Deck List" });
const toast = (page: Page) =>
  page.getByRole("region", { name: "Notifications" });

/**
 * A Charmander with 120 Editions (#365): the swap list reads 60 at a time, and its own Edition (`current`) falls on
 * the second page, so the copy sheet is taller than any screen and the Current row is not in the first page.
 */
async function manyVariants(page: Page, current: string) {
  const row = (index: number, edition: string, number: string) => ({
    edition_id: edition,
    printing_id: `printing-${index}`,
    name: "Charmander",
    set_id: "set-m",
    set_name: "Many Set",
    set_code: "MNY",
    collector_number: number,
    descriptor: { finish: "normal" },
    image_url: null,
    art_url: null,
    card_kind: "pokemon",
    trainer_type: null,
    evolves_from: null,
    regulation_mark: null,
    standing: {},
    owned: 0,
    in_deck: null,
    free: null,
  });
  const first = Array.from({ length: 60 }, (_, index) =>
    row(
      index,
      `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      String(index + 1)
    )
  );
  const second = Array.from({ length: 60 }, (_, index) =>
    index === 5
      ? row(100 + index, current, "999")
      : row(
          100 + index,
          `00000000-0000-4000-8000-${String(100 + index).padStart(12, "0")}`,
          String(100 + index)
        )
  );
  await page.route("**/api/catalog/editions?*identity_id=*", (route) => {
    const second_page = new URL(route.request().url()).searchParams.has(
      "cursor"
    );
    return route.fulfill({
      json: {
        available: true,
        catalog_revision: 1,
        owner_revision: 1,
        last_success: null,
        search: {
          mode: "all",
          text: "",
          set_id: null,
          set_name: null,
          set_code: null,
          number: null,
        },
        editions: second_page ? second : first,
        next_cursor: second_page ? null : "page-2",
        printings: null,
        matches: null,
      },
    });
  });
}

/** Scrolls the copy sheet to Show more, takes it, and checks the Current row stays single and cannot be chosen. */
async function expectSwapListScrolls(page: Page, built: Built) {
  await manyVariants(page, built.editions["edit-1"]);
  await page.goto(`${ORIGIN}/decks/${built.deckId}`);
  // A phone shows the Library or the Deck List, one tab at a time.
  if (page.viewportSize()!.width <= 760)
    await page.getByRole("tab", { name: /^Deck \d/ }).tap();
  await page
    .getByRole("button", { name: /^Charmander, Alpha Set · 4 · Normal/ })
    .first()
    .click();
  const sheet = page.getByRole("dialog", { name: "Charmander" });
  const swaps = sheet.getByRole("region", { name: "Swap this copy for" });
  const current = swaps.locator('li[aria-current="true"]');
  // The Current row leads the list although its Edition is on the second page, and it has no button.
  await expect(current).toHaveCount(1);
  await expect(current).toContainText("Alpha Set · 4 · Normal");
  await expect(current).toContainText("Current");
  await expect(current.getByRole("button")).toHaveCount(0);
  await expect(swaps.getByRole("button", { name: /Many Set/ })).toHaveCount(60);

  const viewport = page.viewportSize()!;
  const frame = (await sheet.boundingBox())!;
  expect(frame.y).toBeGreaterThanOrEqual(0);
  expect(frame.y + frame.height).toBeLessThanOrEqual(viewport.height);
  const more = swaps.getByRole("button", { name: "Show more Editions" });
  await sheet.locator("div.overflow-auto").hover();
  await page.mouse.wheel(0, 100_000);
  await expect(more).toBeInViewport({ ratio: 1 });
  await more.click();
  // Page two adds 59 rows: its own copy of the Current Edition is not listed again.
  await expect(swaps.getByRole("button", { name: /Many Set/ })).toHaveCount(
    119
  );
  await expect(current).toHaveCount(1);
  await expect(more).toHaveCount(0);
  await page.mouse.wheel(0, 100_000);
  await expect(
    swaps.getByRole("button", { name: /Many Set/ }).last()
  ).toBeInViewport({ ratio: 1 });
}

test.describe("on a desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("a card with many Editions scrolls its copy sheet to the last swap row and keeps the Current Edition once", async ({
    page,
  }) => {
    promoteCatalog();
    await signIn(page);
    await expectSwapListScrolls(page, await buildDeck(page, { "edit-1": 2 }));
  });

  test("the library lists Editions free of owned, starting on Owned and the Deck's Target Format, and narrows them", async ({
    page,
  }) => {
    promoteCatalog();
    await signIn(page);
    const built = await buildDeck(page, {}, "expanded");
    await page.goto(`${ORIGIN}/decks/${built.deckId}`);

    const shelf = library(page);
    await expect(shelf.getByRole("radio", { name: "Owned" })).toBeChecked();
    // The format chip starts on the Deck's Target Format (Expanded here, not the Standard default).
    await expect(
      shelf.getByRole("button", { name: "Expanded", exact: true })
    ).toHaveAttribute("aria-pressed", "true");
    const results = shelf.getByRole("list", { name: "Library results" });
    await expect(results.getByRole("button")).toHaveCount(2);
    await expect(
      results.getByRole("button", { name: /^Charmander, set-a 4, / })
    ).toHaveAccessibleName(
      "Charmander, set-a 4, Alpha Set, Normal, 1 free of 3 owned, Expanded legality unknown"
    );
    await expect(
      results.getByRole("button", { name: /^Professor's Research, / })
    ).toHaveAccessibleName(/1 free of 1 owned/);
    await expectPageChecks(page, "deck builder library, Owned");

    // All adds the cards not owned, darkened and with no free count.
    await shelf.getByRole("radio", { name: "All" }).click();
    await expect(results.getByRole("button")).toHaveCount(6);
    await expect(
      results.getByRole("button", { name: /^Pikachu, / })
    ).toHaveAccessibleName(/, not owned, /);
    // Search, a type chip and Any format narrow and widen the list.
    await shelf
      .getByRole("searchbox", { name: "Search the library" })
      .fill("pika");
    await expect(results.getByRole("button")).toHaveCount(1);
    // A misspelling no name contains lists close spellings, and the library says so.
    await shelf
      .getByRole("searchbox", { name: "Search the library" })
      .fill("charmandr");
    await expect(
      shelf.getByRole("searchbox", { name: "Search the library" })
    ).toHaveAccessibleDescription(
      /^No exact matches\. Showing close spellings of “charmandr”\. /
    );
    await expect(results.getByRole("button")).toHaveCount(2);
    await expect(
      results.getByRole("button", { name: /^Charmander, / })
    ).toHaveCount(2);
    await shelf.getByRole("searchbox", { name: "Search the library" }).fill("");
    await shelf.getByRole("button", { name: "Supporter", exact: true }).click();
    await expect(results.getByRole("button")).toHaveCount(1);
    await expect(results.getByRole("button")).toHaveAccessibleName(
      /^Professor's Research, /
    );
    await shelf
      .getByRole("button", { name: "Any format", exact: true })
      .click();
    await expect(results.getByRole("button")).toHaveAccessibleName(
      "Professor's Research, set-b 1, Beta Set, Normal, 1 free of 1 owned"
    );
    await expectPageChecks(page, "deck builder library, All, Supporter");
  });

  test("dragging a library tile in adds one copy, Escape cancels a drag, Undo takes the copy off, and a copy dragged onto the library leaves", async ({
    page,
  }) => {
    promoteCatalog();
    await signIn(page);
    const built = await buildDeck(page);
    const sent = countChanges(page);
    await page.goto(`${ORIGIN}/decks/${built.deckId}`);
    await expect(deckList(page)).toContainText(
      "No cards on this Deck List yet."
    );

    const charmander = library(page).getByRole("button", {
      name: /^Charmander, set-a 4, /,
    });
    await drag(page, charmander, deckList(page));
    await expect(toast(page)).toContainText("Added 1 Charmander.");
    await expect.poll(() => listed(built)).toEqual({ "edit-1": 1 });
    await expect(
      deckList(page).getByRole("button", {
        name: "Charmander, Alpha Set · 4 · Normal, copy 1 of 1: in this Deck",
        exact: true,
      })
    ).toBeVisible();
    await expect(deckList(page)).toContainText("1/60");
    expect(sent).toHaveLength(1);

    // Escape cancels a drag: the drop sends nothing (the Undo below is the next and only command).
    await drag(page, charmander, deckList(page), true);
    await toast(page).getByRole("button", { name: "Undo" }).click();
    await expect(toast(page)).toContainText("Undone: Added 1 Charmander.");
    await expect.poll(() => listed(built)).toEqual({});
    expect(sent).toHaveLength(2);
    expect(JSON.parse(sent[1]).changes).toEqual([
      { edition_id: built.editions["edit-1"], quantity: "0" },
    ]);

    // A copy dragged off the Deck List onto the library takes one copy off.
    await drag(page, charmander, deckList(page));
    await expect.poll(() => listed(built)).toEqual({ "edit-1": 1 });
    const copy = deckList(page).getByRole("button", {
      name: /^Charmander, Alpha Set · 4 · Normal, copy 1 of 1/,
    });
    await drag(page, copy, library(page));
    await expect(toast(page)).toContainText("Removed 1 Charmander.");
    await expect.poll(() => listed(built)).toEqual({});
    await expect(deckList(page)).toContainText(
      "No cards on this Deck List yet."
    );
    // Adding never moves a physical card: the Deck still holds its 2 Charmander.
    const [{ quantity }] = await query<{ quantity: string }>(
      "SELECT quantity FROM holding WHERE location_id=$1",
      [built.deckId]
    );
    expect(quantity).toBe("2");
  });

  test("tapping a tile opens the card popup, and ten fast +1 taps add ten copies in two commands", async ({
    page,
  }) => {
    promoteCatalog();
    await signIn(page);
    const built = await buildDeck(page);
    // The first command waits until every tap is in, so the other nine queue behind it and merge into one batch.
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    let commands = 0;
    const bodies: { changes: { edition_id: string; quantity: string }[] }[] =
      [];
    await page.route("**/deck-list/changes", async (route) => {
      commands += 1;
      bodies.push(route.request().postDataJSON());
      if (commands === 1) await held;
      await route.continue();
    });
    await page.goto(`${ORIGIN}/decks/${built.deckId}`);
    await library(page).getByRole("radio", { name: "All" }).click();
    const pikachu = library(page).getByRole("button", { name: /^Pikachu, / });
    await pikachu.click();

    const popup = page.getByRole("dialog", { name: "Pikachu" });
    // The library sends the small artwork; the popup shows the large one.
    await expect(
      popup.getByRole("img", { name: "Pikachu card art" })
    ).toHaveAttribute(
      "src",
      /^\/api\/art\/[0-9a-f-]{36}\/large\?v=[0-9a-f]{8}$/
    );
    await expect(popup).toContainText("Alpha Set (set-a) · #25 · Normal");
    await expect(popup).toContainText("Not owned");
    await expect(popup).toContainText("Standard legality unknown");
    const stepper = popup.getByRole("group", { name: "Deck List copies" });
    await expect(stepper).toContainText("0 on Deck List");
    await expect(stepper.getByRole("button", { name: "−1" })).toBeDisabled();
    await expectPageChecks(page, "deck builder, library card popup");

    for (let tap = 0; tap < 10; tap++)
      await stepper.getByRole("button", { name: "+1" }).click();
    await expect(stepper).toContainText("10 on Deck List");
    release();
    await expect.poll(() => listed(built)).toEqual({ "edit-3": 10 });
    await expect.poll(() => commands).toBe(2);
    expect(bodies[1].changes).toEqual([
      { edition_id: built.editions["edit-3"], quantity: "10" },
    ]);
    // The toast host is behind the modal, so the popup repeats the last batch's words and its Undo.
    await expect(popup.getByRole("status")).toHaveText("Added 9 Pikachu.");
    await popup.getByRole("button", { name: "Undo" }).click();
    await expect(popup.getByRole("status")).toHaveText(
      "Undone: Added 9 Pikachu."
    );
    await expect.poll(() => listed(built)).toEqual({ "edit-3": 1 });
    await expect(stepper).toContainText("1 on Deck List");
    await stepper.getByRole("button", { name: "−1" }).click();
    await expect.poll(() => listed(built)).toEqual({});
    await expect(stepper.getByRole("button", { name: "−1" })).toBeDisabled();

    // ‹ › and the arrow keys step through the library's results.
    await expect(
      popup.getByRole("group", { name: "Step through the results" })
    ).toContainText("2 / 6");
    await popup.getByRole("button", { name: "Next card" }).click();
    await expect(
      page.getByRole("dialog", { name: "Professor's Research" })
    ).toBeVisible();
    await page.keyboard.press("ArrowLeft");
    await expect(page.getByRole("dialog", { name: "Pikachu" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(pikachu).toBeFocused();
  });

  test("a copy's sheet changes its line by one, swaps a copy for another Edition of the card in one batch, and Undo restores both", async ({
    page,
  }) => {
    promoteCatalog();
    await signIn(page);
    const built = await buildDeck(page, { "edit-1": 2 });
    await page.goto(`${ORIGIN}/decks/${built.deckId}`);

    await deckList(page)
      .getByRole("button", {
        name: /^Charmander, Alpha Set · 4 · Normal, copy 2 of 2/,
      })
      .click();
    const sheet = page.getByRole("dialog", { name: "Charmander" });
    const stepper = sheet.getByRole("group", { name: "Deck List copies" });
    await expect(stepper).toContainText("2 on Deck List");
    await stepper.getByRole("button", { name: "+1" }).click();
    await expect(stepper).toContainText("3 on Deck List");
    await expect.poll(() => listed(built)).toEqual({ "edit-1": 3 });
    // The sheet has two status lines (this feedback and the swap list's loading line), so pick the feedback by its text.
    await expect(
      sheet.getByRole("status").filter({ hasText: "Added 1 Charmander." })
    ).toBeVisible();
    await stepper.getByRole("button", { name: "−1" }).click();
    await expect.poll(() => listed(built)).toEqual({ "edit-1": 2 });

    // Swap this copy for: the other Editions of the same Card Identity.
    const swaps = sheet.getByRole("region", { name: "Swap this copy for" });
    const gamma = swaps.getByRole("button", {
      name: "Charmander, Gamma Set · 9 · Normal, Not owned",
      exact: true,
    });
    await expect(swaps.getByRole("button")).toHaveCount(1);
    // The copy's own Edition is listed first, marked Current, and has no button.
    const current = swaps.locator('li[aria-current="true"]');
    await expect(current).toContainText("Alpha Set · 4 · Normal");
    await expect(current).toContainText("Current");
    await expect(current.getByRole("button")).toHaveCount(0);
    await expectPageChecks(page, "deck builder, copy sheet with editing");
    await gamma.click();
    await expect(sheet).toBeHidden();
    await expect(toast(page)).toContainText(
      "Swapped a copy of Charmander (Alpha Set · 4 · Normal) for Charmander (Gamma Set · 9 · Normal)."
    );
    await expect
      .poll(() => listed(built))
      .toEqual({ "edit-1": 1, "edit-2": 1 });
    // One Undo puts both lines back.
    await toast(page).getByRole("button", { name: "Undo" }).click();
    await expect(toast(page)).toContainText(
      "Undone: Swapped a copy of Charmander"
    );
    await expect.poll(() => listed(built)).toEqual({ "edit-1": 2 });
  });

  test("a List row adds and removes one copy with its buttons", async ({
    page,
  }) => {
    promoteCatalog();
    await signIn(page);
    const built = await buildDeck(page, { "edit-1": 2 });
    await page.goto(`${ORIGIN}/decks/${built.deckId}`);
    await page.getByRole("radio", { name: "List" }).click();
    const add = deckList(page).getByRole("button", {
      name: "Add one Charmander",
    });
    await add.click();
    await expect.poll(() => listed(built)).toEqual({ "edit-1": 3 });
    await expectPageChecks(page, "deck builder, List view with editing");
    const remove = deckList(page).getByRole("button", {
      name: "Remove one Charmander",
    });
    await remove.click();
    await remove.click();
    await expect.poll(() => listed(built)).toEqual({ "edit-1": 1 });
    await expect(toast(page)).toContainText("Removed 1 Charmander.");
  });

  test("Delete and Backspace take a copy off, and an Undo after another change says this deck changed", async ({
    page,
  }) => {
    promoteCatalog();
    await signIn(page);
    const built = await buildDeck(page, { "edit-5": 2, "edit-6": 3 });
    await page.goto(`${ORIGIN}/decks/${built.deckId}`);

    const ball = (copy: string) =>
      deckList(page).getByRole("button", {
        name: `Ultra Ball, Beta Set · 2 · Normal, copy ${copy}: not owned`,
        exact: true,
      });
    await ball("2 of 2").focus();
    await page.keyboard.press("Delete");
    await expect(toast(page)).toContainText("Removed 1 Ultra Ball.");
    await expect
      .poll(() => listed(built))
      .toEqual({ "edit-5": 1, "edit-6": 3 });
    // The pressed copy left; focus stays on the line.
    await expect(ball("1 of 1")).toBeFocused();
    await page.keyboard.press("Backspace");
    await expect.poll(() => listed(built)).toEqual({ "edit-6": 3 });
    // The line left with its last copy, so focus moves to the toast's Undo.
    const undo = toast(page).getByRole("button", { name: "Undo" });
    await expect(undo).toBeFocused();

    // The Deck List changes somewhere else before Undo: the inverse batch is refused and changes nothing.
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
      await raiseLine(pool, built.deckId, built.editions["edit-6"], 1);
    } finally {
      await pool.end();
    }
    await undo.click();
    await expect(toast(page)).toContainText("Can't undo: this deck changed.");
    await expect.poll(() => listed(built)).toEqual({ "edit-6": 4 });
    await expect(deckList(page)).toContainText("4/60");
  });
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

  test("a card with many Editions scrolls its copy sheet to the last swap row and keeps the Current Edition once", async ({
    page,
  }) => {
    promoteCatalog();
    await signIn(page);
    await expectSwapListScrolls(page, await buildDeck(page, { "edit-1": 2 }));
  });

  test("the Library tab lists the library, its card popup is a bottom sheet with ±1, and the Deck tab counts the copy", async ({
    page,
  }) => {
    promoteCatalog();
    await signIn(page);
    const built = await buildDeck(page, { "edit-1": 1 });
    await page.goto(`${ORIGIN}/decks/${built.deckId}`);

    await expect(page.getByRole("tab", { name: "Library" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    const charmander = library(page).getByRole("button", {
      name: /^Charmander, set-a 4, /,
    });
    await expect(charmander).toBeVisible();
    await expectPageChecks(page, "phone library");

    await charmander.tap();
    const popup = page.getByRole("dialog", { name: "Charmander" });
    const stepper = popup.getByRole("group", { name: "Deck List copies" });
    await expect(stepper).toContainText("1 on Deck List");
    await expectPageChecks(page, "phone library card popup");
    await stepper.getByRole("button", { name: "+1" }).tap();
    await expect.poll(() => listed(built)).toEqual({ "edit-1": 2 });
    await popup.getByRole("button", { name: "Close card details" }).tap();
    await expect(page.getByRole("tab", { name: "Deck 2/60" })).toBeVisible();

    // The Deck tab keeps the library mounted behind it; its pile's sheet has the editing controls.
    await page.getByRole("tab", { name: "Deck 2/60" }).tap();
    // The Deck read after the edit settles takes the copy out of the surplus group; until it lands, the surplus tile
    // shares the pile's name, and while the Deck pane is still hidden neither shows.
    await expect(
      page.getByRole("button", { name: /^Charmander, Alpha Set · 4/ })
    ).toHaveCount(1);
    await page
      .getByRole("button", { name: /^Charmander, Alpha Set · 4/ })
      .tap();
    const sheet = page.getByRole("dialog", { name: "Charmander" });
    await expect(
      sheet.getByRole("group", { name: "Deck List copies" })
    ).toContainText("2 on Deck List");
    await expect(
      sheet
        .getByRole("region", { name: "Swap this copy for" })
        .getByRole("button")
    ).toHaveCount(1);
    await expectPageChecks(page, "phone copy sheet with editing");
    await sheet.getByRole("button", { name: "Close card" }).tap();
    await page.getByRole("tab", { name: "Library" }).tap();
    await expect(charmander).toBeVisible();

    // The List view's rows have their own 44 px −1 and +1.
    await page.getByRole("tab", { name: "Deck 2/60" }).tap();
    await page.getByRole("radio", { name: "List" }).click();
    await expectPageChecks(page, "phone List view with editing");
    // The +1 edit's toast sits over the bottom of a phone screen, where the row lands below the header's four actions
    // (Replace list…, #215): dismiss it first.
    await page
      .getByRole("region", { name: "Notifications" })
      .getByRole("button", { name: "Dismiss", exact: true })
      .tap();
    await page.getByRole("button", { name: "Add one Charmander" }).tap();
    await expect.poll(() => listed(built)).toEqual({ "edit-1": 3 });
  });
});
