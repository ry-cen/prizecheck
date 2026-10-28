import { test, expect, type Page } from "@playwright/test";
import { signInAsOwner } from "./support/sign-in";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { expectPageChecks } from "./support/page-check";
import { expectTouchTarget } from "./support/touch-target";
import { listCards } from "./support/deck-list";
import { startAsNewOwner } from "./support/owner";

// The deck builder's Target Format (#178): header row 2's "Standard ⌄ · ✓ Legal" control (the chevron is an icon) changes the Deck's Target
// Format through its Deck List command from a kit menu of radio items (owner decision 2026-10-14), the result opens the results dialog, and a card-level issue highlights its
// lines. The cards come through the real catalog import with real TCGdex-shaped records, so the real rules files judge
// them on the API's check date (pinned below, so the real date never changes the outcome): Bulbasaur, four Rare Candy, four Switch and 51 Basic Grass Energy are legal in Standard and
// Expanded until the next rotation, and four-ofs break Gym Leader Challenge's one-copy rule.

const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";

// The check date the API uses for this file's tests: api/tests/catalog_process_fixture/today_fixture.py reads it from
// $CATALOG_PROCESS_FIXTURE_DIR/today. A day on which the cards below are legal in Standard and Expanded.
const TODAY = "2026-10-28";
const todayFile = () => {
  const directory = process.env.CATALOG_PROCESS_FIXTURE_DIR;
  if (!directory) throw new Error("CATALOG_PROCESS_FIXTURE_DIR is not set");
  return join(directory, "today");
};

test.beforeAll(() => {
  mkdirSync(join(todayFile(), ".."), { recursive: true });
  writeFileSync(todayFile(), TODAY);
});
test.afterAll(() => {
  rmSync(todayFile(), { force: true });
});

/** Replaces the catalog with the format-check fixtures of api/tests/test_card_attributes.py. Clears every Holding. */
function promoteCatalog() {
  execFileSync(
    ".venv/bin/python",
    [
      "-c",
      `import test_catalog_search as search
from test_card_attributes import BULBASAUR_ME, ENERGY_SV, RARE_CANDY_ME, SWITCH_ME
records = {record["id"]: record for record in (BULBASAUR_ME, RARE_CANDY_ME, SWITCH_ME, ENERGY_SV)}
class Real(search.SearchSource):
    def fetch(self, source_id):
        return records[source_id]
search.SearchSource = Real
search.promote({key: record["name"] for key, record in records.items()})`,
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

async function editionOf(sourceId: string): Promise<string> {
  const rows = await query<{ id: string }>(
    `SELECT e.id FROM catalog_edition e JOIN catalog_printing p ON p.id=e.printing_id
     WHERE p.source_id=$1 AND e.descriptor->>'finish'='normal'`,
    [sourceId]
  );
  return rows[0].id;
}

type Built = { deckId: string; owner: string; energy: string };

/** A 60-card Deck List that holds none of its cards: legal in Standard and Expanded, not in Gym Leader Challenge. */
async function buildDeck(page: Page): Promise<Built> {
  const created = await page.request.post(`${ORIGIN}/api/decks`, {
    headers: { origin: ORIGIN },
    data: {
      name: `Bulbasaur ${randomUUID().slice(0, 6)}`,
      idempotency_key: randomUUID(),
    },
  });
  expect(created.status()).toBe(201);
  const deckId = (await created.json()).location.id as string;
  const [{ owner_id: owner }] = await query<{ owner_id: string }>(
    "SELECT owner_id FROM location WHERE id=$1",
    [deckId]
  );
  const energy = await editionOf("sv02-278");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await listCards(pool, owner, deckId, {
      [await editionOf("me01-001")]: 1,
      [await editionOf("me01-125")]: 4,
      [await editionOf("me01-130")]: 4,
      [energy]: 51,
    });
  } finally {
    await pool.end();
  }
  return { deckId, owner, energy };
}

/** How many times the page has asked for the Deck's cost since `stubPrices`. */
const costReads = { count: 0 };
/** While set, the cost route holds its answer until this resolves, then names the Deck's real revisions. */
const costHold: { gate: Promise<void> | null } = { gate: null };

/** Fixed cost and price answers, so nothing waits on the price cache. */
async function stubPrices(page: Page, deckId: string) {
  costReads.count = 0;
  costHold.gate = null;
  const figure = {
    status: "unavailable",
    reason: "not_cached",
    total_copies: "60",
    priced_copies: "0",
    stale_copies: "0",
    unknown_age_copies: "0",
    fallback_copies: "0",
    amount: null,
    display_amount: null,
    currency: "USD",
  };
  await page.route("**/api/decks/*/cost", async (route) => {
    costReads.count++;
    let deckListRevision: number | null = null;
    if (costHold.gate) {
      await costHold.gate;
      deckListRevision = (await deckRead(page, deckId)).deck_list.revision;
    }
    return route.fulfill({
      json: {
        deck_id: deckId,
        ...figure,
        owner_revision: null,
        deck_list_revision: deckListRevision,
        deck_list_cost: figure,
        cost_to_complete: figure,
      },
    });
  });
  await page.route("**/api/prices/editions", async (route) => {
    const ids = (route.request().postDataJSON() as { edition_ids: string[] })
      .edition_ids;
    await route.fulfill({
      json: {
        withheld: false,
        prices: ids.map((id) => ({
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
        })),
      },
    });
  });
}

async function deckRead(page: Page, deckId: string) {
  const response = await page.request.get(`${ORIGIN}/api/decks/${deckId}`);
  expect(response.ok()).toBe(true);
  return response.json();
}

const control = (page: Page) =>
  page.getByRole("group", { name: "Target Format and result" });
/** The Target Format menu button, named for the Format it shows ("Target Format: Standard"). */
const formatButton = (page: Page) =>
  control(page).getByRole("button", { name: /^Target Format: / });
const formatMenu = (page: Page) =>
  page.getByRole("menu", { name: /^Target Format: / });
const resultButton = (page: Page) =>
  control(page).getByRole("button", { name: /result$/ });

/** Opens the Target Format menu and chooses `format` ("Gym Leader Challenge"). */
async function chooseFormat(page: Page, format: string) {
  await formatButton(page).click();
  await formatMenu(page)
    .getByRole("menuitemradio", { name: format, exact: true })
    .click();
  await expect(formatMenu(page)).toHaveCount(0);
}

/** The open menu lies inside the viewport, so no item is off the page's edge. */
async function expectMenuInView(page: Page) {
  const box = (await formatMenu(page).boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
}

test.describe("on a desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("the Target Format control changes the Format, opens its result and highlights the lines a card issue names", async ({
    page,
  }) => {
    promoteCatalog();
    await signIn(page);
    const built = await buildDeck(page);
    await stubPrices(page, built.deckId);
    await page.goto(`${ORIGIN}/decks/${built.deckId}`);

    // A new Deck targets Standard, where this list is legal.
    await expect(formatButton(page)).toHaveAccessibleName(
      "Target Format: Standard"
    );
    await expect.poll(() => costReads.count).toBe(1);
    await expect(formatButton(page)).toHaveText(/^Standard$/);
    await expect(formatButton(page).locator("svg")).toHaveCount(1);
    await expect(resultButton(page)).toHaveText(/^✓\s*Legal/);
    await expect(resultButton(page)).toHaveAccessibleName(
      /Legal\. Show the Standard result$/
    );
    await expect(
      page.getByRole("button", { name: /^Rare Candy, .*copy 1 of 4/ })
    ).not.toHaveAccessibleDescription(/format issue/);
    await expectPageChecks(page, "deck builder, Target Format legal");

    // The result opens the results dialog: the date, the result, the rules version and the disclaimer.
    await resultButton(page).click();
    const standard = page.getByRole("dialog", { name: "Standard result" });
    await expect(standard).toContainText(/Legal\s*in Standard as of/);
    await expect(standard).toContainText("No issues found.");
    await expect(standard).toContainText(
      /Rules version \d+ \(\d{4}-\d{2}-\d{2}\)/
    );
    await expect(standard).toContainText("Advisory format checks");
    await expectPageChecks(page, "deck builder, Standard result");
    // A later "as of" date carries the future-rules note.
    const later = new Date(Date.parse(TODAY) + 30 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    await standard.getByLabel("As of").fill(later);
    await expect(standard).toContainText(`${later} is in the future`);
    await page.keyboard.press("Escape");
    await expect(standard).toBeHidden();
    await expect(resultButton(page)).toBeFocused();

    // The Format button opens the menu: the three Formats as radio items, Standard checked and focused.
    await formatButton(page).click();
    await expect(formatButton(page)).toHaveAttribute("aria-expanded", "true");
    const items = formatMenu(page).getByRole("menuitemradio");
    await expect(items).toHaveText([
      "Standard",
      "Expanded",
      "Gym Leader Challenge",
    ]);
    await expect(items.nth(0)).toHaveAttribute("aria-checked", "true");
    await expect(items.nth(0)).toBeFocused();
    await expectMenuInView(page);
    await expectPageChecks(page, "deck builder, Target Format menu open");
    // Escape closes it and returns focus to the button, changing nothing.
    await page.keyboard.press("Escape");
    await expect(formatMenu(page)).toHaveCount(0);
    await expect(formatButton(page)).toBeFocused();

    // From the keyboard: ArrowDown opens on the checked item, ArrowDown and Enter choose Gym Leader Challenge, and
    // the header shows its result.
    await page.keyboard.press("ArrowDown");
    await expect(items.nth(0)).toBeFocused();
    await page.keyboard.press("End");
    await expect(items.nth(2)).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(formatMenu(page)).toHaveCount(0);
    await expect(formatButton(page)).toBeFocused();
    await expect(formatButton(page)).toHaveAccessibleName(
      "Target Format: Gym Leader Challenge"
    );
    await expect(resultButton(page)).toHaveText(/^✕\s*Not legal/);
    await expect(resultButton(page)).toHaveAccessibleName(
      /Not legal, 2 issues\. Show the Gym Leader Challenge result$/
    );
    expect((await deckRead(page, built.deckId)).target_format).toBe("glc");
    // A Format change moves the Deck List revision, not the cards: the cost is not asked for again.
    expect(costReads.count).toBe(1);

    // A card-level issue highlights its lines; other lines stay plain.
    for (const name of ["Rare Candy", "Switch"])
      await expect(
        page.getByRole("button", {
          name: new RegExp(`^${name}, .*copy 1 of 4`),
        })
      ).toHaveAccessibleDescription(/format issue/);
    await expect(
      page.getByRole("button", { name: /^Bulbasaur, .*copy 1 of 1/ })
    ).not.toHaveAccessibleDescription(/format issue/);
    // Stacked and List mark the same lines.
    for (const view of ["Stacked", "List"]) {
      await page.getByRole("radio", { name: view }).click();
      for (const name of ["Rare Candy", "Switch"])
        await expect(
          page.getByRole("button", { name: new RegExp(`^${name}`) })
        ).toHaveAccessibleDescription(/format issue/);
      await expect(
        page.getByRole("button", { name: /^Bulbasaur/ })
      ).not.toHaveAccessibleDescription(/format issue/);
    }
    await page.getByRole("radio", { name: "Spread" }).click();
    await expectPageChecks(page, "deck builder, Target Format not legal");

    await resultButton(page).click();
    const glc = page.getByRole("dialog", {
      name: "Gym Leader Challenge result",
    });
    const cards = glc.getByRole("region", { name: "Card issues" });
    await expect(cards.getByRole("listitem")).toHaveCount(2);
    await expect(cards).toContainText("more than 1 copy of Rare Candy (4)");
    await expect(cards).toContainText("Rare Candy (Mega Evolution · 125 ·");
    await expect(glc).toContainText("Rules version");
    await expectPageChecks(page, "deck builder, Gym Leader Challenge result");
    await glc.getByRole("button", { name: "Close result" }).click();
    await expect(glc).toBeHidden();

    // The choice is the Deck's: a reload keeps it, and the menu checks it.
    await page.reload();
    await expect(formatButton(page)).toHaveAccessibleName(
      "Target Format: Gym Leader Challenge"
    );
    await formatButton(page).click();
    await expect(
      formatMenu(page).getByRole("menuitemradio", { checked: true })
    ).toHaveText("Gym Leader Challenge");
    await page.keyboard.press("Escape");

    // Nothing blocks editing: the Deck List can go over 60, and the control still answers.
    const revision = (await deckRead(page, built.deckId)).deck_list.revision;
    const over = await page.request.patch(
      `${ORIGIN}/api/decks/${built.deckId}/deck-list/lines/${built.energy}`,
      {
        headers: { origin: ORIGIN },
        data: { quantity: "56", revision, idempotency_key: randomUUID() },
      }
    );
    expect(over.status()).toBe(200);
    await page.reload();
    await expect(page.getByRole("region", { name: "Deck List" })).toContainText(
      "65/60"
    );
    await chooseFormat(page, "Standard");
    await expect(resultButton(page)).toHaveText(/^✕\s*Not legal/);
    await resultButton(page).click();
    await expect(
      page
        .getByRole("dialog", { name: "Standard result" })
        .getByRole("region", { name: "Deck issues" })
    ).toContainText("deck has exactly 60 cards; this one has 65");
  });

  test("a cost answered for the revision a Target Format change produced still settles", async ({
    page,
  }) => {
    promoteCatalog();
    await signIn(page);
    const built = await buildDeck(page);
    await stubPrices(page, built.deckId);
    let release!: () => void;
    costHold.gate = new Promise<void>((resolve) => (release = resolve));
    await page.goto(`${ORIGIN}/decks/${built.deckId}`);
    await expect(formatButton(page)).toHaveAccessibleName(
      "Target Format: Standard"
    );
    await expect.poll(() => costReads.count).toBe(1);

    // The cost request is still in flight when the format change commits a newer Deck List revision, and the answer
    // names that revision: the page must not wait for it forever.
    await chooseFormat(page, "Gym Leader Challenge");
    await expect(formatButton(page)).toHaveAccessibleName(
      "Target Format: Gym Leader Challenge"
    );
    release();
    await expect(page.getByText(/^Deck price unavailable/)).toBeVisible();
    await expect(page.getByText("Checking prices…")).toHaveCount(0);
  });

  test("a change from a page that missed an edit re-reads the Deck and says so", async ({
    page,
  }) => {
    promoteCatalog();
    await signIn(page);
    const built = await buildDeck(page);
    await stubPrices(page, built.deckId);
    await page.goto(`${ORIGIN}/decks/${built.deckId}`);
    await expect(formatButton(page)).toHaveAccessibleName(
      "Target Format: Standard"
    );

    // Another tab edits the Deck List, so this page's revision is stale.
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
      await listCards(pool, built.owner, built.deckId, { [built.energy]: 50 });
    } finally {
      await pool.end();
    }
    await chooseFormat(page, "Expanded");
    await expect(
      page.getByRole("status").filter({ hasText: "changed" })
    ).toContainText(
      "This Deck changed somewhere else, so its Target Format wasn't changed."
    );
    await expect(formatButton(page)).toHaveAccessibleName(
      "Target Format: Standard"
    );
    expect((await deckRead(page, built.deckId)).target_format).toBe("standard");

    // After the re-read, the same choice goes through.
    await chooseFormat(page, "Expanded");
    await expect(formatButton(page)).toHaveAccessibleName(
      "Target Format: Expanded"
    );
    await expect
      .poll(async () => (await deckRead(page, built.deckId)).target_format)
      .toBe("expanded");
  });
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

  test("the Target Format control and its result fit a phone", async ({
    page,
  }) => {
    promoteCatalog();
    await signIn(page);
    const built = await buildDeck(page);
    await stubPrices(page, built.deckId);
    await page.goto(`${ORIGIN}/decks/${built.deckId}`);
    await page.getByRole("tab", { name: /^Deck / }).tap();
    // The menu opens below the button, inside the screen, with 44 px items.
    await formatButton(page).tap();
    await expectMenuInView(page);
    for (const item of await formatMenu(page).getByRole("menuitemradio").all())
      await expectTouchTarget(item, ["height"]);
    await expectPageChecks(page, "phone deck builder, Target Format menu open");
    await formatMenu(page)
      .getByRole("menuitemradio", { name: "Gym Leader Challenge" })
      .tap();
    await expect(formatMenu(page)).toHaveCount(0);
    await expect(resultButton(page)).toHaveText(/^✕\s*Not legal/);
    await expectPageChecks(page, "phone deck builder, Target Format");

    await resultButton(page).tap();
    const glc = page.getByRole("dialog", {
      name: "Gym Leader Challenge result",
    });
    await expect(glc).toContainText("more than 1 copy of Switch (4)");
    await expectPageChecks(
      page,
      "phone deck builder, Gym Leader Challenge result"
    );
    await glc.getByRole("button", { name: "Close result" }).tap();
    await expect(glc).toBeHidden();
  });
});
