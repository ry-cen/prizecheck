import { test, expect, type Page } from "@playwright/test";
import { signInAsOwner } from "./support/sign-in";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { expectPageChecks } from "./support/page-check";
import { expectTouchTarget } from "./support/touch-target";
import { startAsNewOwner } from "./support/owner";

// Importing a list into a new Deck (#212): Decks' Import a list button opens /decks/import, where a pasted TCG Live or
// Limitless list is read by the server (a live count of card lines and cards), named, and given a Target Format; the
// review ("Check the list") opens on the lines that need the collector, where Fix searches the catalog or drops the
// line, Restore brings a dropped line back, and Edition chooses among a card's Editions; Create Deck then makes the
// Deck and its Deck List in one command and lands in its builder, where Undo deletes it again. The shared page check
// runs on the paste screen and on the review with the resolver open, at 1280×800 and 375×812.

const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";

// A 1×1 PNG stands in for card artwork, so no test reaches the network.
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=",
  "base64"
);

/** The browser catalog (api/tests/deck_import_fixtures.py): every Printing of the Limitless list F3 except Meowth ex
 * POR 62, with a Meowth ex in another set and three Basic Energy cards for the resolver's search to find. */
function seedCatalog() {
  execFileSync(
    ".venv/bin/python",
    [
      "-c",
      "from deck_import_fixtures import seed_import_browser_catalog\nseed_import_browser_catalog()",
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
  await page.route(/^https:\/\/assets\.tcgdex\.net\//, (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: PIXEL })
  );
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query("DELETE FROM auth_send_event");
    await startAsNewOwner(pool);
  } finally {
    await pool.end();
  }
  await signInAsOwner(page, "/decks");
  await expect(
    page.getByRole("heading", { name: "Decks", level: 1, exact: true })
  ).toBeVisible();
}

// The Limitless list F3 (api/tests/deck_import_fixtures.py): 24 card lines, 60 cards.
const F3 =
  "Pokémon: 19\n4 Dreepy TWM 128\n4 Drakloak TWM 129\n3 Dragapult ex TWM 130\n2 Munkidori TWM 95\n2 Budew ASC 16\n1 Dunsparce TEF 128\n1 Dudunsparce TEF 129\n1 Meowth ex POR 62\n1 Fezandipiti ex ASC 142\n\nTrainer: 32\n4 Lillie's Determination MEG 119\n3 Boss's Orders MEG 114\n2 Crispin SCR 133\n1 Rosa's Encouragement POR 84\n1 Judge POR 76\n4 Buddy-Buddy Poffin TEF 144\n4 Poké Pad POR 81\n4 Crushing Hammer POR 71\n3 Ultra Ball MEG 131\n3 Night Stretcher ASC 196\n1 Unfair Stamp TWM 165\n2 Risky Ruins MEG 127\n\nEnergy: 9\n3 Fire Energy MEE 10\n3 Psychic Energy MEE 13\n3 Darkness Energy MEE 15\n";

const lineItem = (page: Page, text: string) =>
  page.getByRole("listitem").filter({ hasText: text });

const chip = (page: Page, name: string) =>
  page
    .getByRole("group", { name: "Show lines" })
    .getByRole("button", { name: new RegExp(`^${name} \\d+$`) });

const pasteStatus = (page: Page) =>
  page.getByRole("region", { name: "Paste" }).getByRole("status");

const saveRegion = (page: Page) => page.getByRole("region", { name: "Save" });

const notifications = (page: Page) =>
  page.getByRole("region", { name: "Notifications" });

/** Fix on a flagged line, then Drop line. */
async function dropFlagged(page: Page, text: string) {
  await lineItem(page, text).getByRole("button", { name: "Fix" }).click();
  await page.getByRole("button", { name: "Drop line" }).click();
}

test.describe("on a desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("imports the Limitless list into a new Deck: the review opens on Needs you, lines are picked, dropped and restored, an Edition is chosen, and Undo removes the Deck", async ({
    page,
  }) => {
    seedCatalog();
    await signIn(page);
    const name = `Dragapult ${randomUUID().slice(0, 8)}`;

    await page.getByRole("button", { name: "Import a list" }).click();
    await expect(page).toHaveURL(/\/decks\/import$/);
    await expect(
      page.getByRole("heading", { name: "Import a decklist", level: 1 })
    ).toBeVisible();

    await page.getByLabel("Decklist").fill(F3);
    await expect(pasteStatus(page)).toHaveText("24 card lines · 60 cards");
    const review = page.getByRole("button", { name: "Review 24 lines" });
    await expect(review).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByText("Name the Deck first.")).toBeVisible();

    await page.getByLabel("Deck name").fill(name);
    await page.getByLabel("Target Format").selectOption("expanded");
    await expect(review).not.toHaveAttribute("aria-disabled", "true");
    await review.click();

    await expect(
      page.getByRole("heading", { name: "Check the list", level: 1 })
    ).toBeFocused();
    await expect(chip(page, "Needs you")).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await expect(chip(page, "Needs you")).toHaveText("Needs you 4");
    await expect(chip(page, "All")).toHaveText("All 24");
    await expect(page.getByRole("main").getByRole("listitem")).toHaveCount(4);
    await expect(saveRegion(page)).toContainText(
      "4 lines to resolve before you can save"
    );
    const create = page.getByRole("button", { name: "Create Deck" });
    await expect(create).toHaveAttribute("aria-disabled", "true");
    const summary = page.getByRole("complementary", {
      name: "Import summary",
    });
    await expect(summary).toContainText("60");
    await expect(summary).not.toContainText("(not 60)");

    // Pick a card for the line the catalog doesn't hold under its code.
    await lineItem(page, "1 Meowth ex POR 62")
      .getByRole("button", { name: "Fix" })
      .click();
    await expect(page.getByLabel("Search the catalog")).toBeFocused();
    await expect(page.getByLabel("Search the catalog")).toHaveValue(
      "Meowth ex"
    );
    await page
      .getByRole("list", { name: "Catalog results" })
      .getByRole("button", { name: "Meowth ex MEG 150" })
      .click();
    await expect(chip(page, "Needs you")).toHaveText("Needs you 3");
    await expect(chip(page, "Changed")).toHaveText("Changed 1");

    await lineItem(page, "3 Fire Energy MEE 10")
      .getByRole("button", { name: "Fix" })
      .click();
    await page
      .getByRole("button", { name: "Basic Fire Energy sve 002" })
      .click();
    await expect(chip(page, "Needs you")).toHaveText("Needs you 2");

    await dropFlagged(page, "3 Psychic Energy MEE 13");
    await dropFlagged(page, "3 Darkness Energy MEE 15");
    await expect(chip(page, "Needs you")).toHaveText("Needs you 0");
    await expect(chip(page, "Dropped")).toHaveText("Dropped 2");
    await expect(saveRegion(page)).toContainText(
      "Ready · 54 cards · 22 Deck List lines"
    );
    await expect(create).not.toHaveAttribute("aria-disabled", "true");
    await expect(summary).toContainText("54 (not 60)");

    // Restore brings a dropped line back to the lines that need you.
    await chip(page, "Dropped").click();
    await lineItem(page, "3 Darkness Energy MEE 15")
      .getByRole("button", { name: "Restore" })
      .click();
    await expect(chip(page, "Needs you")).toHaveText("Needs you 1");
    await expect(saveRegion(page)).toContainText(
      "1 line to resolve before you can save"
    );
    await chip(page, "Needs you").click();
    await dropFlagged(page, "3 Darkness Energy MEE 15");
    await expect(chip(page, "Needs you")).toHaveText("Needs you 0");

    // Choose the Reverse Holo Edition of a matched line.
    await chip(page, "All").click();
    const lillie = lineItem(page, "4 Lillie's Determination MEG 119");
    await lillie.getByRole("button", { name: "Edition" }).click();
    const editions = page.getByRole("group", {
      name: "Edition for 4 Lillie's Determination MEG 119",
    });
    await expect(
      editions.getByRole("button", { name: "Normal · no price" })
    ).toHaveAttribute("aria-pressed", "true");
    await editions
      .getByRole("button", { name: "Reverse Holo · no price" })
      .click();
    await expect(lillie).toContainText(
      "4 MEG 119 · Reverse Holo · your choice · no price"
    );
    await expect(chip(page, "Changed")).toHaveText("Changed 3");

    await expectPageChecks(page, "import review, ready to save");

    await create.click();
    await expect(page).toHaveURL(/\/decks\/[0-9a-f-]{36}$/);
    await expect(
      page.getByRole("heading", { level: 1, name, exact: true })
    ).toBeVisible();
    await expect(notifications(page)).toContainText(
      `Created ${name} with 54 cards.`
    );
    const id = page.url().split("/").pop()!;

    const response = await page.request.get(`${ORIGIN}/api/decks/${id}`);
    expect(response.status()).toBe(200);
    const deck = (await response.json()) as {
      target_format: string;
      deck_list: { lines: { edition_id: string; quantity: string }[] };
    };
    expect(deck.target_format).toBe("expanded");
    expect(
      deck.deck_list.lines.reduce((sum, l) => sum + Number(l.quantity), 0)
    ).toBe(54);
    const [reverse] = await query<{ id: string }>(
      "SELECT e.id FROM catalog_edition e JOIN catalog_printing p ON p.id=e.printing_id WHERE p.source_id='me01-119' AND e.descriptor->>'finish'='reverse'"
    );
    expect(
      deck.deck_list.lines.find((l) => l.edition_id === reverse.id)?.quantity
    ).toBe("4");

    await notifications(page).getByRole("button", { name: "Undo" }).click();
    await expect(page).toHaveURL(/\/decks$/);
    await expect(notifications(page)).toContainText(`Removed ${name}.`);
    const gone = await page.request.get(`${ORIGIN}/api/decks/${id}`);
    expect(gone.status()).toBe(404);
  });

  test("refuses a paste over 20,000 characters before posting it, and reads one of exactly 20,000 through the gateway", async ({
    page,
  }) => {
    seedCatalog();
    await signIn(page);
    await page.goto(`${ORIGIN}/decks/import`);
    await expect(
      page.getByRole("heading", { name: "Import a decklist", level: 1 })
    ).toBeVisible();

    await page.getByLabel("Decklist").fill("x".repeat(20_001));
    await expect(pasteStatus(page)).toContainText(
      "This paste is over 20,000 characters. Paste one decklist at a time."
    );
    await expect(page.getByRole("button", { name: /^Review/ })).toHaveAttribute(
      "aria-disabled",
      "true"
    );

    await page
      .getByLabel("Decklist")
      .fill("4 Dreepy TWM 128\n" + "x".repeat(20_000 - 17));
    await expect(pasteStatus(page)).toHaveText(
      "1 card line · 4 cards · 1 other line will be ignored"
    );
  });
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

  test("the paste screen and the review fit a phone: summary above the list, 44 px controls, the save bar above the tab bar", async ({
    page,
  }) => {
    seedCatalog();
    await signIn(page);
    const name = `Phone ${randomUUID().slice(0, 8)}`;

    const importButton = page.getByRole("button", { name: "Import a list" });
    await expectTouchTarget(importButton);
    await importButton.tap();
    await expect(
      page.getByRole("heading", { name: "Import a decklist", level: 1 })
    ).toBeVisible();

    await page.getByLabel("Decklist").fill(F3 + "Total Cards: 60\n");
    await page.getByLabel("Deck name").fill(name);
    await expect(pasteStatus(page)).toHaveText(
      "24 card lines · 60 cards · 1 other line will be ignored"
    );
    await expectPageChecks(page, "import paste on a phone");

    await page.getByRole("button", { name: "Review 24 lines" }).tap();
    await expect(chip(page, "Needs you")).toHaveText("Needs you 4");

    const summary = page.getByRole("complementary", {
      name: "Import summary",
    });
    const firstItem = page.getByRole("main").getByRole("listitem").first();
    await expect(summary).toBeVisible();
    await expect(firstItem).toBeVisible();
    const summaryBox = await summary.boundingBox();
    const itemBox = await firstItem.boundingBox();
    expect(summaryBox!.y).toBeLessThan(itemBox!.y);

    await expectTouchTarget(chip(page, "Needs you"));
    await expectTouchTarget(page.getByRole("button", { name: "Create Deck" }));
    await expectTouchTarget(
      page.getByRole("button", { name: "Back to paste" })
    );
    await expectTouchTarget(page.getByText("1 line ignored: not cards"));

    await lineItem(page, "1 Meowth ex POR 62")
      .getByRole("button", { name: "Fix" })
      .tap();
    await expectTouchTarget(page.getByRole("button", { name: "Drop line" }));
    await expectTouchTarget(
      page
        .getByRole("list", { name: "Catalog results" })
        .getByRole("button")
        .first()
    );
    await expectPageChecks(
      page,
      "import review with the resolver open on a phone"
    );
    await page.getByRole("button", { name: "Drop line" }).tap();
    for (const text of [
      "3 Fire Energy MEE 10",
      "3 Psychic Energy MEE 13",
      "3 Darkness Energy MEE 15",
    ]) {
      await lineItem(page, text).getByRole("button", { name: "Fix" }).tap();
      await page.getByRole("button", { name: "Drop line" }).tap();
    }
    await expect(saveRegion(page)).toContainText(
      "Ready · 50 cards · 20 Deck List lines"
    );

    // Every line shows, so the page is taller than the window; the save bar stays above the tab bar.
    await chip(page, "All").tap();
    await expect(
      page.getByRole("main").getByRole("listitem").last()
    ).not.toBeInViewport();
    await expect(saveRegion(page)).toBeInViewport();
    const tabs = page.getByRole("navigation", { name: "Main views" });
    await expect(saveRegion(page)).toBeVisible();
    await expect(tabs).toBeVisible();
    const saveBox = await saveRegion(page).boundingBox();
    const tabBox = await tabs.boundingBox();
    expect(saveBox!.y + saveBox!.height).toBeLessThanOrEqual(tabBox!.y + 0.5);

    await page.getByRole("button", { name: "Create Deck" }).tap();
    await expect(page).toHaveURL(/\/decks\/[0-9a-f-]{36}$/);
    await notifications(page).getByRole("button", { name: "Undo" }).tap();
    await expect(page).toHaveURL(/\/decks$/);
  });
});
