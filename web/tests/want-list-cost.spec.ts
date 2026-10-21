import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { Pool } from "pg";
import { startAsNewOwner } from "./support/owner";
import { expectPageChecks } from "./support/page-check";
import { signInAsOwner } from "./support/sign-in";
import { expectTouchTarget } from "./support/touch-target";

// The Want List's cost and Buy on TCGplayer (decklist import #210). The worked example of want-list.spec.ts (its
// helpers are copied here so the two specs change independently), with one unpriced card: Charizard ex (older) lists 4
// Iono and holds 1, Gardevoir ex (newer) lists 3 Iono and 1 card with no price (an Unspecified Variant, never priced),
// and one Iono is loose on a Shelf. Iono has a fresh $0.25 quote, so no read waits for a refresh. Under Every Deck built
// at once Charizard ex needs 2 Iono ($0.50), Gardevoir ex needs 3 Iono ($0.75) and the unpriced card, and the total is
// 6 cards: $1.25 for the 5 priced, and 1 card without a price.

const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

/** Runs Python against the live stack's database, passing `argument` as a JSON file. */
function python(code: string, argument: object = {}): string {
  const path = `${process.env.TMPDIR || "/tmp"}/want-list-cost-${randomUUID()}.json`;
  writeFileSync(path, JSON.stringify(argument));
  return execFileSync(".venv/bin/python", ["-c", code, path], {
    env: { ...process.env, PYTHONPATH: "api:api/tests" },
    maxBuffer: 64 * 1024 * 1024,
  }).toString();
}

/** The price spec's catalog: a fresh $0.25 quote on the normal Edition, and the Unspecified Variant, never priced. */
function editions(): { iono: string; unpriced: string } {
  const out = python(`import json
from test_prices import ui_world
print('WORLD' + json.dumps(ui_world(0)))`);
  const ids = JSON.parse(out.slice(out.lastIndexOf("WORLD") + 5)) as {
    normal: string;
    unspecified: string;
  };
  const ago = (hours: number) =>
    new Date(Date.now() - hours * 3_600_000).toISOString();
  python(
    `import json, sys
from test_prices import ui_apply
ui_apply(json.load(open(sys.argv[1])))`,
    [
      {
        op: "quote",
        edition: ids.normal,
        amount: "0.25",
        updated: ago(1),
        checked: ago(0.1),
      },
    ]
  );
  return { iono: ids.normal, unpriced: ids.unspecified };
}

async function signIn(page: Page, next = "/decks") {
  // Card artwork never reaches the network.
  await page.route(/^https:\/\/assets\.tcgdex\.net\//, (route) =>
    route.abort()
  );
  await pool.query("DELETE FROM auth_send_event");
  await startAsNewOwner(pool);
  await signInAsOwner(page, next);
  await expect(
    page.getByRole("navigation", { name: "Main views" })
  ).toBeVisible();
}

async function api(
  page: Page,
  method: "GET" | "POST" | "PUT",
  path: string,
  data?: object
) {
  const response = await page.request.fetch(`${ORIGIN}${path}`, {
    method,
    headers: { origin: ORIGIN },
    data,
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

async function createDeck(page: Page, name: string, daysAgo: number) {
  const created = await api(page, "POST", "/api/decks", {
    name,
    idempotency_key: randomUUID(),
  });
  const id = created.location.id as string;
  // Creation time decides the section order and which Deck counts a spare copy first.
  await pool.query(
    "UPDATE location SET created_at=now()-$2::interval WHERE id=$1",
    [id, `${daysAgo} days`]
  );
  return id;
}

const hold = (
  page: Page,
  location: string,
  edition: string,
  quantity: number
) =>
  api(page, "POST", "/api/holdings", {
    location_id: location,
    edition_id: edition,
    quantity: String(quantity),
    idempotency_key: randomUUID(),
  });

async function setLine(
  page: Page,
  deckId: string,
  edition: string,
  quantity: number
) {
  const detail = await api(page, "GET", `/api/decks/${deckId}`);
  await api(page, "POST", `/api/decks/${deckId}/deck-list/changes`, {
    revision: detail.deck_list.revision,
    idempotency_key: randomUUID(),
    changes: [{ edition_id: edition, quantity: String(quantity) }],
  });
}

async function world(page: Page) {
  const { iono, unpriced } = editions();
  const suffix = randomUUID().slice(0, 6);
  const names = {
    charizard: `Charizard ex ${suffix}`,
    gardevoir: `Gardevoir ex ${suffix}`,
  };
  const ids = {
    charizard: await createDeck(page, names.charizard, 3),
    gardevoir: await createDeck(page, names.gardevoir, 2),
  };
  await hold(page, ids.charizard, iono, 1); // a copy arriving in a Deck lists it (migration 031)
  await setLine(page, ids.charizard, iono, 4);
  await setLine(page, ids.gardevoir, iono, 3);
  await setLine(page, ids.gardevoir, unpriced, 1);
  const shelf = await api(page, "POST", "/api/location-tree", {
    name: `Shelf ${suffix}`,
    parent_id: null,
    parent_version: null,
    idempotency_key: randomUUID(),
  });
  await hold(page, shelf.location.id, iono, 1);
  return { names, ids };
}

async function oneDeckAtATime(page: Page) {
  const settings = await api(page, "GET", "/api/settings");
  await api(page, "PUT", "/api/settings/want-list-counting", {
    want_list_counting: "one_at_a_time",
    revision: settings.revision,
    idempotency_key: randomUUID(),
  });
}

const chip = (page: Page, name: string) =>
  page
    .getByRole("group", { name: "Show Decks" })
    .getByRole("button", { name, exact: true });
const summary = (page: Page, name = "Want List") =>
  page.getByRole("region", { name, exact: true });
const deckSection = (page: Page, name: string) =>
  page.getByRole("region", { name, exact: true });
const needs = (page: Page, name: string) =>
  page.getByRole("list", { name: `What ${name} needs` }).getByRole("listitem");
const total = (page: Page) =>
  page.getByRole("complementary", { name: /^Combined total/ });
const indexRow = (page: Page, name: string) =>
  page
    .getByRole("navigation", { name: "Deck index" })
    .getByRole("listitem")
    .filter({ has: page.getByRole("link", { name, exact: true }) });

test.afterEach(async () => {
  // ui_world activates a matching rule that verifies new Editions' mappings; later specs on this stack seed their own.
  await pool.query("UPDATE catalog_rule_state SET activation_id=NULL");
});
test.afterAll(async () => {
  await pool.end();
});

test.describe("on a desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("the page draws first, then shows the estimated cost, the cards priced and each section's, line's and row's cost", async ({
    page,
  }) => {
    await signIn(page);
    const { names } = await world(page);

    // The cost is held until the page has drawn: the lists and counts never wait for prices.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route("**/api/want-list/cost**", async (route) => {
      await held;
      await route.continue();
    });
    await page.goto(`${ORIGIN}/decks/want-list`);
    await expect(needs(page, names.charizard)).toContainText("2 of 4");
    await expect(summary(page)).toContainText("6 cards");
    await expect(summary(page)).toContainText("Checking prices…");
    await expect(
      page.getByRole("button", { name: "Buy on TCGplayer" })
    ).toBeEnabled();
    await expect(page.getByText("$1.25")).toHaveCount(0);
    release();

    await expect(summary(page)).toContainText("Estimated cost$1.25");
    await expect(summary(page)).toContainText("5/6 cards priced");
    // The unpriced card is reported on its own and never counted as $0.
    await expect(summary(page)).toContainText(
      "1 card without a price, not counted"
    );
    await expect(deckSection(page, names.charizard)).toContainText(
      "2 cards to get$0.50"
    );
    await expect(needs(page, names.charizard)).toContainText(
      "$0.50 · $0.25 each"
    );
    await expect(deckSection(page, names.gardevoir)).toContainText(
      "4 cards to get$0.75 + 1 unpriced"
    );
    await expect(needs(page, names.gardevoir)).toHaveCount(2);
    await expect(
      needs(page, names.gardevoir).filter({ hasText: "$0.75 · $0.25 each" })
    ).toHaveCount(1);
    await expect(
      needs(page, names.gardevoir).filter({ hasText: "No price" })
    ).toHaveCount(1);
    await expect(total(page)).toHaveAccessibleName(
      "Combined total · 6 cards · $1.25 + 1 unpriced"
    );
    await expect(
      total(page).getByRole("listitem").filter({ hasText: "$1.25" })
    ).toContainText("5");
    await expect(
      total(page).getByRole("listitem").filter({ hasText: "No price" })
    ).toHaveCount(1);
    await expectPageChecks(page, "the Want List with its cost");

    // A Deck card's Want List button carries the same cost as its section.
    await page.unroute("**/api/want-list/cost**");
    await page.goto(`${ORIGIN}/decks`);
    await expect(
      indexRow(page, names.charizard).getByRole("button", {
        name: "Want List: 2 cards · $0.50",
        exact: true,
      })
    ).toBeVisible();
    await expect(
      indexRow(page, names.gardevoir).getByRole("button", {
        name: "Want List: 4 cards · $0.75 + 1 unpriced",
        exact: true,
      })
    ).toBeVisible();
  });

  test("Buy on TCGplayer exports what the page shows and names the scope and the counting", async ({
    page,
  }) => {
    await signIn(page);
    const { names } = await world(page);
    await page.goto(`${ORIGIN}/decks/want-list`);
    await expect(summary(page)).toContainText("Estimated cost$1.25");

    // All Decks: the combined total, prepared as the dialog opens. One card has no verified product, so the complete
    // text is offered with the deck builder's coverage and less-specific wording.
    const buy = page.getByRole("button", { name: "Buy on TCGplayer" });
    await buy.click();
    let dialog = page.getByRole("dialog", { name: "Buy the Want List total" });
    await expect(dialog).toContainText(
      "6 cards, counted as Every Deck built at once."
    );
    let mass = dialog.getByRole("region", {
      name: "TCGplayer export",
      exact: true,
    });
    await expect(mass.getByLabel("TCGplayer Mass Entry text")).toHaveText(
      /^(5 Furret\n1 Furret|1 Furret\n5 Furret)$/
    );
    await expect(mass).toContainText(
      "Some cards can't be opened in TCGplayer from here, so there's no link."
    );
    await expect(mass).toContainText(
      "Less specific: 2 of 2 rows give only a card name."
    );
    await expect(mass).toContainText(
      "Opening TCGplayer does not buy anything and shows no price for these cards."
    );
    await expectPageChecks(page, "Buy on TCGplayer, All Decks");
    await dialog
      .getByRole("button", { name: "Close TCGplayer export" })
      .click();
    await expect(buy).toBeFocused();

    // One Deck: that Deck's needs, every one a verified product, so TCGplayer opens from a link.
    await chip(page, names.charizard).click();
    await expect(summary(page, `Want List · ${names.charizard}`)).toContainText(
      "Estimated cost$0.50"
    );
    await buy.click();
    dialog = page.getByRole("dialog", {
      name: `Buy what ${names.charizard} needs`,
    });
    await expect(dialog).toContainText(
      "2 cards, counted as Every Deck built at once."
    );
    mass = dialog.getByRole("region", {
      name: "TCGplayer export",
      exact: true,
    });
    await expect(mass).toContainText(
      "Ready to open in TCGplayer: 1 Printing, 2 copies."
    );
    await expect(
      mass.getByRole("button", { name: "Open in TCGplayer" })
    ).toBeVisible();
    await dialog
      .getByRole("button", { name: "Close TCGplayer export" })
      .click();

    // One Deck at a time: Gardevoir ex counts the loose copy and Charizard ex's, and the total is the largest need.
    await oneDeckAtATime(page);
    await page.goto(`${ORIGIN}/decks/want-list`);
    await expect(summary(page)).toContainText("Estimated cost$0.50");
    await expect(summary(page)).toContainText("2/3 cards priced");
    await buy.click();
    dialog = page.getByRole("dialog", { name: "Buy the Want List total" });
    await expect(dialog).toContainText(
      "3 cards, counted as One Deck at a time."
    );
    await expect(
      dialog
        .getByRole("region", { name: "TCGplayer export", exact: true })
        .getByLabel("TCGplayer Mass Entry text")
    ).toHaveText(/^(2 Furret\n1 Furret|1 Furret\n2 Furret)$/);
  });
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

  test("the cost and Buy on TCGplayer fit the phone", async ({ page }) => {
    await signIn(page);
    const names = await world(page);
    await page.goto(`${ORIGIN}/decks`);
    const indexButton = indexRow(page, names.gardevoir).getByRole("button", {
      name: "Want List: 4 cards · $0.75 + 1 unpriced",
      exact: true,
    });
    await expect(indexButton).toBeVisible();
    await expectTouchTarget(indexButton);
    await expectPageChecks(
      page,
      "the Decks index with Want List costs on a phone"
    );
    await page.goto(`${ORIGIN}/decks/want-list`);
    await expect(
      page.getByText("Combined total · 6 cards · $1.25 + 1 unpriced")
    ).toBeVisible();
    const buy = page.getByRole("button", { name: "Buy on TCGplayer" });
    await expectTouchTarget(buy);
    await expectPageChecks(page, "the Want List with its cost on a phone");
    await buy.tap();
    const dialog = page.getByRole("dialog", {
      name: "Buy the Want List total",
    });
    await expect(dialog.getByLabel("TCGplayer Mass Entry text")).toBeVisible();
    await expectPageChecks(page, "Buy on TCGplayer on a phone");
  });
});
