import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { Pool } from "pg";
import { startAsNewOwner } from "./support/owner";
import { expectPageChecks } from "./support/page-check";
import { signInAsOwner } from "./support/sign-in";
import { expectTouchTarget } from "./support/touch-target";

// The Want List view inside Decks (decklist import #209). The spec's worked example on one Edition, standing in for
// Iono PAL 185: Charizard ex (older) lists 4 and holds 1, Gardevoir ex (newer) lists 3 and holds none, one copy is
// loose on a Shelf, and Miraidon ex (newest) lists and holds one copy of another Edition. Under Every Deck built at once
// (the default) Charizard ex takes the loose copy and needs 2, Gardevoir ex needs all 3 and the total is 5; under One
// Deck at a time Gardevoir ex counts the loose copy and Charizard ex's and needs 1, and the total is the largest need,
// 2. Prices are fresh cached quotes, so the Decks index rows' cost reads never wait for a refresh.

const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

/** Runs Python against the live stack's database, passing `argument` as a JSON file. */
function python(code: string, argument: object = {}): string {
  const path = `${process.env.TMPDIR || "/tmp"}/want-list-${randomUUID()}.json`;
  writeFileSync(path, JSON.stringify(argument));
  return execFileSync(".venv/bin/python", ["-c", code, path], {
    env: { ...process.env, PYTHONPATH: "api:api/tests" },
    maxBuffer: 64 * 1024 * 1024,
  }).toString();
}

/** The price spec's catalog with a fresh $0.25 quote on its normal and reverse Editions. */
function editions(): { iono: string; other: string } {
  const out = python(`import json
from test_prices import ui_world
print('WORLD' + json.dumps(ui_world(0)))`);
  const ids = JSON.parse(out.slice(out.lastIndexOf("WORLD") + 5)) as {
    normal: string;
    "reverse-holofoil": string;
  };
  const ago = (hours: number) =>
    new Date(Date.now() - hours * 3_600_000).toISOString();
  python(
    `import json, sys
from test_prices import ui_apply
ui_apply(json.load(open(sys.argv[1])))`,
    [ids.normal, ids["reverse-holofoil"]].map((edition) => ({
      op: "quote",
      edition,
      amount: "0.25",
      updated: ago(1),
      checked: ago(0.1),
    }))
  );
  return { iono: ids.normal, other: ids["reverse-holofoil"] };
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
  method: "GET" | "POST",
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
  // Creation time decides the section order and which Deck counts a spare copy first; set it so it never depends on
  // timing.
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

/** The worked example's three Decks and a loose copy; returns their names and ids. */
async function world(page: Page) {
  const { iono, other } = editions();
  const suffix = randomUUID().slice(0, 6);
  const names = {
    charizard: `Charizard ex ${suffix}`,
    gardevoir: `Gardevoir ex ${suffix}`,
    miraidon: `Miraidon ex ${suffix}`,
  };
  const ids = {
    charizard: await createDeck(page, names.charizard, 3),
    gardevoir: await createDeck(page, names.gardevoir, 2),
    miraidon: await createDeck(page, names.miraidon, 1),
  };
  await hold(page, ids.charizard, iono, 1); // a copy arriving in a Deck lists it (migration 031)
  await setLine(page, ids.charizard, iono, 4);
  await setLine(page, ids.gardevoir, iono, 3);
  await hold(page, ids.miraidon, other, 1); // complete
  const shelf = await api(page, "POST", "/api/location-tree", {
    name: `Shelf ${suffix}`,
    parent_id: null,
    parent_version: null,
    idempotency_key: randomUUID(),
  });
  await hold(page, shelf.location.id, iono, 1);
  return { names, ids };
}

const views = (page: Page) => page.getByRole("tablist", { name: "Decks view" });
const chips = (page: Page) => page.getByRole("group", { name: "Show Decks" });
const chip = (page: Page, name: string) =>
  chips(page).getByRole("button", { name, exact: true });
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

  test("the switch shows every Deck's section and the combined total, and a Deck page or a chip scopes it to one Deck", async ({
    page,
  }) => {
    await signIn(page);
    const { names, ids } = await world(page);

    // My Decks shows the cost to complete.
    await page.goto(`${ORIGIN}/decks`);
    await expect(
      views(page).getByRole("tab", { name: "My Decks" })
    ).toHaveAttribute("aria-selected", "true");
    await expect(indexRow(page, names.charizard)).toContainText(
      "$0.50 to complete (2/2 priced)"
    );
    await expect(indexRow(page, names.gardevoir)).toContainText(
      "$0.75 to complete (3/3 priced)"
    );
    await expect(indexRow(page, names.miraidon)).not.toContainText(
      "Nothing to get"
    );
    await expect(
      indexRow(page, names.miraidon).getByRole("button", { name: /^Want List/ })
    ).toHaveCount(0);

    await indexRow(page, names.miraidon)
      .getByRole("link", { name: names.miraidon, exact: true })
      .click();
    const wantList = page.getByRole("button", {
      name: "Want List",
      exact: true,
    });
    await expect(wantList).toBeEnabled();
    await wantList.click();
    await expect(page).toHaveURL(
      `${ORIGIN}/decks/want-list?deck=${ids.miraidon}`
    );
    await expect(page.getByText("Nothing to get")).toBeVisible();
    await views(page).getByRole("tab", { name: "My Decks" }).click();

    // The switch opens All Decks: a section per Deck, oldest first, and the combined total.
    await views(page).getByRole("tab", { name: "Want List" }).click();
    await expect(page).toHaveURL(`${ORIGIN}/decks/want-list`);
    await expect(
      views(page).getByRole("tab", { name: "Want List" })
    ).toBeFocused();
    await expect(chip(page, "All Decks")).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await expect(
      page
        .getByRole("heading", { level: 3 })
        .filter({ hasNotText: "Combined total" })
    ).toHaveText([names.charizard, names.gardevoir, names.miraidon]);
    await expect(
      page.getByRole("heading", { level: 2, name: "Want List" })
    ).toBeVisible();
    await expect(page.getByText("To get", { exact: true })).toBeVisible();
    await expect(page.getByText("5 cards", { exact: true })).toBeVisible();
    await expect(needs(page, names.charizard)).toHaveCount(1);
    await expect(needs(page, names.charizard)).toContainText("2 of 4");
    await expect(needs(page, names.charizard)).toContainText(
      "Have 1 in this Deck · 1 spare"
    );
    await expect(needs(page, names.gardevoir)).toContainText("3 of 3");
    await expect(needs(page, names.gardevoir)).toContainText(
      "Your 2 are counted for other Decks"
    );
    await expect(deckSection(page, names.miraidon)).toContainText(
      "Nothing to get"
    );
    await expect(total(page)).toHaveAccessibleName(
      "Combined total · 5 cards · $1.25"
    );
    await expect(total(page).getByRole("listitem")).toHaveCount(1);
    await expect(total(page).getByRole("listitem")).toContainText(
      `${names.charizard} 2 · ${names.gardevoir} 3`
    );
    // The total stays in view beside the sections as the page scrolls.
    await expect(total(page)).toHaveCSS("position", "sticky");
    await expect(
      page.getByText("Counting: Every Deck built at once.")
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Change it in Settings" })
    ).toHaveAttribute("href", "/settings");
    await expectPageChecks(page, "the Want List, All Decks");

    // A chip scopes the view to one Deck: its section only, no combined total.
    await chip(page, names.gardevoir).click();
    await expect(page).toHaveURL(
      `${ORIGIN}/decks/want-list?deck=${ids.gardevoir}`
    );
    await expect(chip(page, names.gardevoir)).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await expect(
      page.getByRole("heading", {
        level: 2,
        name: `Want List · ${names.gardevoir}`,
      })
    ).toBeVisible();
    await expect(page.getByText(`${names.gardevoir} needs`)).toBeVisible();
    await expect(page.getByText("3 cards", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { level: 3 })).toHaveText([
      names.gardevoir,
    ]);
    await expect(total(page)).toHaveCount(0);
    await expectPageChecks(page, "the Want List, one Deck");
    // A reload keeps the scope.
    await page.reload();
    await expect(chip(page, names.gardevoir)).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await chip(page, "All Decks").click();
    await expect(page).toHaveURL(`${ORIGIN}/decks/want-list`);
    await expect(total(page)).toBeVisible();

    // A Deck page opens its scoped view; the switch always opens All Decks.
    await views(page).getByRole("tab", { name: "My Decks" }).click();
    await expect(page).toHaveURL(`${ORIGIN}/decks`);
    await indexRow(page, names.gardevoir)
      .getByRole("link", { name: names.gardevoir, exact: true })
      .click();
    await page.getByRole("button", { name: "Want List", exact: true }).click();
    await expect(page).toHaveURL(
      `${ORIGIN}/decks/want-list?deck=${ids.gardevoir}`
    );
    await expect(chip(page, names.gardevoir)).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await expect(page.getByRole("heading", { level: 3 })).toHaveText([
      names.gardevoir,
    ]);
    await views(page).getByRole("tab", { name: "My Decks" }).click();
    await views(page).getByRole("tab", { name: "Want List" }).click();
    await expect(chip(page, "All Decks")).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await expect(total(page)).toBeVisible();

    // Open Deck goes to the builder.
    await deckSection(page, names.charizard)
      .getByRole("link", { name: `Open Deck ${names.charizard}` })
      .click();
    await expect(page).toHaveURL(`${ORIGIN}/decks/${ids.charizard}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      names.charizard
    );
  });

  test("One Deck at a time names the Deck whose copies a line counts and the total takes the largest need", async ({
    page,
  }) => {
    await signIn(page);
    const { names } = await world(page);
    await page.goto(`${ORIGIN}/decks/want-list`);
    await page.getByRole("link", { name: "Change it in Settings" }).click();
    await expect(page).toHaveURL(`${ORIGIN}/settings`);
    await page
      .getByRole("group", { name: "Want List counting" })
      .getByRole("radio", { name: "One Deck at a time" })
      .click();
    await expect(
      page.getByRole("region", { name: "Decks" }).getByRole("status")
    ).toHaveText("Want List counting set to One Deck at a time.");

    await page.goto(`${ORIGIN}/decks/want-list`);
    await expect(page.getByText("Counting: One Deck at a time.")).toBeVisible();
    await expect(needs(page, names.gardevoir)).toContainText("1 of 3");
    await expect(needs(page, names.gardevoir)).toContainText(
      `Have 1 spare · 1 in ${names.charizard}`
    );
    await expect(needs(page, names.charizard)).toContainText("2 of 4");
    await expect(page.getByText("2 cards", { exact: true })).toBeVisible();
    await expect(total(page)).toHaveAccessibleName(
      "Combined total · 2 cards · $0.50"
    );
    await expect(total(page).getByRole("listitem")).toContainText(
      `${names.charizard} 2 · ${names.gardevoir} 1`
    );

    // The Deck card shows the updated cost to complete.
    await views(page).getByRole("tab", { name: "My Decks" }).click();
    await expect(indexRow(page, names.gardevoir)).toContainText(
      "$0.25 to complete (1/1 priced)"
    );

    // An address scoped to a Deck that isn't one of yours falls back to All Decks.
    await page.goto(`${ORIGIN}/decks/want-list?deck=${randomUUID()}`);
    await expect(
      page.getByText("That Deck wasn't found. Showing All Decks.")
    ).toBeVisible();
    await expect(chip(page, "All Decks")).toHaveAttribute(
      "aria-pressed",
      "true"
    );

    // So does an address whose Deck isn't an id at all.
    await page.goto(`${ORIGIN}/decks/want-list?deck=not-a-uuid`);
    await expect(chip(page, "All Decks")).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await expect(
      page.getByText("The Want List couldn't be loaded.")
    ).toHaveCount(0);
    await expect(page).toHaveURL(`${ORIGIN}/decks/want-list`);
    await expect(total(page)).toBeVisible();
  });
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

  for (const width of [320, 375, 390]) {
    test(`long Deck scope chips fit at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await signIn(page);
      const name =
        "Charizard ex with a very long Deck name for the regional championship finals";
      const deck = await createDeck(page, name, 1);
      const { iono } = editions();
      await setLine(page, deck, iono, 2);

      for (const scoped of [false, true]) {
        await page.goto(
          `${ORIGIN}/decks/want-list${scoped ? `?deck=${deck}` : ""}`
        );
        const deckChip = chip(page, name);
        await expect(deckChip).toBeVisible();
        await expect(deckChip).toHaveAccessibleName(name);
        await expect(deckChip).toHaveAttribute("aria-pressed", String(scoped));
        await expectTouchTarget(deckChip);
        await expect(deckChip.locator("[title]")).toHaveAttribute(
          "title",
          name
        );
        await expect.soft
          .poll(() =>
            page.evaluate(
              () =>
                document.documentElement.scrollWidth -
                document.documentElement.clientWidth
            )
          )
          .toBeLessThanOrEqual(0);
      }
    });
  }

  test("the combined total is a collapsed row under the summary, and nothing scrolls sideways", async ({
    page,
  }) => {
    await signIn(page);
    const { names } = await world(page);
    await page.goto(`${ORIGIN}/decks`);
    await expectTouchTarget(
      indexRow(page, names.gardevoir).getByRole("link", {
        name: names.gardevoir,
        exact: true,
      })
    );
    await expectPageChecks(page, "My Decks on a phone");

    await views(page).getByRole("tab", { name: "Want List" }).tap();
    await expect(page).toHaveURL(`${ORIGIN}/decks/want-list`);
    const row = page.getByText("Combined total · 5 cards");
    await expect(row).toBeVisible();
    // Collapsed: the cards it lists are hidden until it is opened.
    await expect(page.getByRole("list", { name: "Cards to get" })).toBeHidden();
    await expect(total(page)).toHaveCount(0);
    await expectTouchTarget(row);
    await expectTouchTarget(chip(page, "All Decks"));
    await expectTouchTarget(
      page.getByRole("link", { name: `Open Deck ${names.charizard}` })
    );
    await expectPageChecks(page, "the Want List on a phone, total closed");
    await row.tap();
    await expect(
      page.getByRole("list", { name: "Cards to get" }).getByRole("listitem")
    ).toContainText(`${names.charizard} 2 · ${names.gardevoir} 3`);
    await expectPageChecks(page, "the Want List on a phone, total open");

    await chip(page, names.gardevoir).tap();
    await expect(page.getByRole("heading", { level: 3 })).toHaveText([
      names.gardevoir,
    ]);
    await expect(page.getByText(/^Combined total/)).toHaveCount(0);
    await expectPageChecks(page, "the Want List on a phone, one Deck");
  });
});
