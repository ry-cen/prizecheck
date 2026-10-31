import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { startAsNewOwner } from "./support/owner";
import { expectPageChecks } from "./support/page-check";
import { signInAsOwner } from "./support/sign-in";
import { expectTouchTarget } from "./support/touch-target";

// Trade Wants and Will accept on the Want List page (Trading #275). The catalog is the Swap catalog
// (api/tests/want_list_swap_fixtures.py): three Iono Printings, Basic Psychic Energy SVE 5 and SVE 13, and others.
// The Trade Wants panel ends the Want List at All Decks, and shows without Decks too: Add a card searches the catalog by
// name and adds one copy, each line's stepper changes it, and 0 removes it. Each Want List line has a Will accept select,
// one choice per card wherever it appears, which outlives a reload. Neither changes a Want List figure.

const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";
const OWNER_EMAIL = process.env.OWNER_EMAIL || "owner@example.test";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

type Editions = {
  "PAL 185": string;
  "PAL 254": string;
  "PAF 80": string;
  "SVE 5": string;
  "SVE 13": string;
};

/** The Swap catalog through the real catalog import (it replaces the catalog); returns the Edition ids by key. */
function seedCatalog(): Editions {
  const out = execFileSync(
    ".venv/bin/python",
    [
      "-c",
      "from want_list_swap_fixtures import print_swap_catalog\nprint_swap_catalog()",
    ],
    {
      env: { ...process.env, PYTHONPATH: "api:api/tests" },
      maxBuffer: 64 * 1024 * 1024,
    }
  ).toString();
  return JSON.parse(out.slice(out.lastIndexOf("SWAP") + 4)) as Editions;
}

async function signIn(page: Page) {
  // Card artwork never reaches the network.
  await page.route(/^https:\/\/assets\.tcgdex\.net\//, (route) =>
    route.abort()
  );
  await pool.query("DELETE FROM auth_send_event");
  await startAsNewOwner(pool);
  await signInAsOwner(page, "/decks");
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
  await pool.query(
    "UPDATE location SET created_at=now()-$2::interval WHERE id=$1",
    [id, `${daysAgo} days`]
  );
  return id;
}

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

/** The collector's Trade Wants as {Edition id: quantity} and their Will accept choices as {Edition id: rule}. */
async function tradeWants(page: Page) {
  const body = await api(page, "GET", "/api/trade-wants");
  return {
    lines: Object.fromEntries(
      (body.lines as { edition_id: string; quantity: string }[]).map((line) => [
        line.edition_id,
        line.quantity,
      ])
    ),
    rules: Object.fromEntries(
      (body.will_accept as { edition_id: string; rule: string }[]).map(
        (choice) => [choice.edition_id, choice.rule]
      )
    ),
  };
}

/** Fills the signed-in collector's Trade Wants to `count` lines with direct writes: Editions of Arven SVI 166's
 * Printing that no catalog generation lists (the API test's `extra_editions`), one copy each. */
async function fill(count: number) {
  const user = await pool.query('SELECT id FROM "user" WHERE email=$1', [
    OWNER_EMAIL,
  ]);
  await pool.query(
    `WITH printing AS (SELECT id FROM catalog_printing WHERE source_id='sv01-166'),
     extra AS (INSERT INTO catalog_edition(printing_id, descriptor_key, descriptor)
       SELECT printing.id, 'cap-' || g, jsonb_build_object('finish', 'cap-' || g)
       FROM printing, generate_series(1, $2::int) g RETURNING id)
     INSERT INTO trade_want(owner_id, edition_id, quantity) SELECT $1, id, 1 FROM extra`,
    [user.rows[0].id, count]
  );
}

const panel = (page: Page) => page.getByRole("region", { name: "Trade Wants" });
const picker = (page: Page) => page.getByRole("dialog", { name: "Add a card" });
const notifications = (page: Page) =>
  page.getByRole("region", { name: "Notifications" });
const IONO_254 = /^Iono \(Paldea Evolved · 254 · Normal\)$/;
const energy = (page: Page) =>
  page.getByRole("list", { name: /^What .* needs$/ }).getByRole("radiogroup", {
    name: /^Will accept for Basic Psychic Energy \(Scarlet & Violet Energies · 013 /,
  });

/** Add a card, search by name, and add one copy of Iono PAL 254. */
async function addIono(page: Page) {
  await panel(page).getByRole("button", { name: "Add a card" }).click();
  await expect(picker(page)).toBeVisible();
  await picker(page)
    .getByRole("searchbox", { name: "Search by card name" })
    .fill("Iono");
  await expect(
    picker(page).getByRole("list", { name: "Iono" }).getByRole("listitem")
  ).toHaveCount(3);
  await picker(page)
    .getByRole("button", { name: /^Add Iono \(Paldea Evolved · 254 / })
    .click();
}

test.afterAll(async () => {
  await pool.end();
});

test.describe("on a desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("a Trade Wants line is added from a name search, stepped up and removed at 0, with no Decks", async ({
    page,
  }) => {
    test.slow();
    const ids = seedCatalog();
    await signIn(page);
    await page.goto(`${ORIGIN}/decks/want-list`);
    await expect(page.getByText(/^No Decks yet\./)).toBeVisible();
    await expect(panel(page)).toContainText(
      "Cards you want in trades that no Deck names."
    );
    await expect(panel(page)).toContainText("No Trade Wants yet.");

    await addIono(page);
    await expect(notifications(page)).toContainText("Added to Trade Wants");
    await expect(picker(page)).toContainText("1 in Trade Wants");
    await picker(page).getByRole("searchbox").fill("Nobody by this name");
    await expect(picker(page)).toContainText("No cards match that name.");
    await expectPageChecks(page, "the Add a card picker");
    await picker(page).getByRole("button", { name: "Done" }).click();
    await expect(picker(page)).toHaveCount(0);

    const lines = panel(page)
      .getByRole("list", { name: "Your Trade Wants" })
      .getByRole("listitem");
    await expect(lines).toHaveCount(1);
    await expect(lines).toContainText("Iono");
    await expect(lines).toContainText("Paldea Evolved · 254 · Normal");
    await expectPageChecks(page, "the Trade Wants panel with a line");
    await panel(page)
      .getByRole("button", { name: /^Increase Iono \(Paldea Evolved · 254 / })
      .click();
    await expect(
      panel(page).getByRole("group", { name: IONO_254 })
    ).toContainText("2");
    expect((await tradeWants(page)).lines).toEqual({ [ids["PAL 254"]]: "2" });

    for (let n = 0; n < 2; n++)
      await panel(page)
        .getByRole("button", {
          name: /^Decrease Iono \(Paldea Evolved · 254 /,
        })
        .click();
    await expect(notifications(page)).toContainText("Removed from Trade Wants");
    await expect(panel(page)).toContainText("No Trade Wants yet.");
    expect((await tradeWants(page)).lines).toEqual({});
  });

  test("at 500 lines a new card is refused with the cap message, and a line can still change", async ({
    page,
  }) => {
    test.slow();
    const ids = seedCatalog();
    await signIn(page);
    await createDeck(page, `Deck ${randomUUID().slice(0, 6)}`, 1);
    // The first write makes the collector's owner row; then 499 more lines reach the cap.
    await api(page, "PUT", `/api/trade-wants/${ids["PAL 254"]}`, {
      quantity: "1",
    });
    await fill(499);
    await page.goto(`${ORIGIN}/decks/want-list`);
    await expect(
      panel(page)
        .getByRole("list", { name: "Your Trade Wants" })
        .getByRole("listitem")
    ).toHaveCount(500);

    await panel(page).getByRole("button", { name: "Add a card" }).click();
    await picker(page)
      .getByRole("searchbox", { name: "Search by card name" })
      .fill("Iono");
    await picker(page)
      .getByRole("button", { name: /^Add Iono \(Paldean Fates · 080 / })
      .click();
    await expect(picker(page).getByRole("status")).toHaveText(
      "You can have up to 500 Trade Wants. Remove one to add another."
    );
    // Adding one more of a card already on the list is a change, not a new line.
    await picker(page)
      .getByRole("button", { name: /^Add Iono \(Paldea Evolved · 254 / })
      .click();
    await expect(picker(page)).toContainText("2 in Trade Wants");
    // Refuse again, then close the picker: the old refusal doesn't stay on the panel.
    await picker(page)
      .getByRole("button", { name: /^Add Iono \(Paldean Fates · 080 / })
      .click();
    await expect(picker(page).getByRole("status")).toContainText("up to 500");
    await picker(page).getByRole("button", { name: "Done" }).click();
    await expect(picker(page)).toHaveCount(0);
    await expect(panel(page)).not.toContainText("up to 500");
    const after = await tradeWants(page);
    expect(Object.keys(after.lines)).toHaveLength(500);
    expect(after.lines[ids["PAL 254"]]).toBe("2");
    expect(after.lines[ids["PAF 80"]]).toBeUndefined();
  });

  test("Will accept is one choice per card in every Deck, outlives a reload and changes no figure", async ({
    page,
  }) => {
    const ids = seedCatalog();
    await signIn(page);
    const suffix = randomUUID().slice(0, 6);
    const older = await createDeck(page, `Older ${suffix}`, 2);
    const newer = await createDeck(page, `Newer ${suffix}`, 1);
    await setLine(page, older, ids["SVE 13"], 2);
    await setLine(page, newer, ids["SVE 13"], 1);
    await page.goto(`${ORIGIN}/decks/want-list`);
    await expect(energy(page)).toHaveCount(2);
    await expect(
      energy(page)
        .first()
        .getByRole("radio", { name: "This exact card", exact: true })
    ).toBeChecked();
    await expect(page.getByText("3 cards", { exact: true })).toBeVisible();
    await expectPageChecks(page, "the Want List with Will accept choices");

    await energy(page)
      .first()
      .getByRole("radio", { name: "Any finish", exact: true })
      .check();
    await expect(notifications(page)).toContainText(
      /^Trades will match any finish for Basic Psychic Energy \(Scarlet & Violet Energies · 013 /
    );
    await expect(
      energy(page)
        .nth(1)
        .getByRole("radio", { name: "Any finish", exact: true })
    ).toBeChecked();
    expect((await tradeWants(page)).rules).toEqual({
      [ids["SVE 13"]]: "printing",
    });
    await expect(page.getByText("3 cards", { exact: true })).toBeVisible();

    await page.reload();
    await expect(
      energy(page)
        .first()
        .getByRole("radio", { name: "Any finish", exact: true })
    ).toBeChecked();
    await expect(
      energy(page)
        .nth(1)
        .getByRole("radio", { name: "Any finish", exact: true })
    ).toBeChecked();
    await energy(page)
      .nth(1)
      .getByRole("radio", { name: "This exact card", exact: true })
      .check();
    // The radio group shows the choice at once; wait for the save to land before reading it back.
    await expect(energy(page).nth(1)).not.toHaveAttribute(
      "aria-disabled",
      "true"
    );
    await expect(
      energy(page)
        .first()
        .getByRole("radio", { name: "This exact card", exact: true })
    ).toBeChecked();
    expect((await tradeWants(page)).rules).toEqual({});
  });

  test("a Will accept choice shows at once while it saves, and the saved one returns when it fails", async ({
    page,
  }) => {
    const ids = seedCatalog();
    await signIn(page);
    const deck = await createDeck(page, `Deck ${randomUUID().slice(0, 6)}`, 1);
    await setLine(page, deck, ids["SVE 13"], 1);
    await page.goto(`${ORIGIN}/decks/want-list`);
    await expect(
      energy(page).getByRole("radio", { name: "This exact card", exact: true })
    ).toBeChecked();

    const group = energy(page);
    const printing = group.getByRole("radio", {
      name: "Any finish",
      exact: true,
    });
    const identity = group.getByRole("radio", {
      name: "Any card with the same name",
      exact: true,
    });
    const writes: string[] = [];
    page.on("request", (request) => {
      if (
        request.method() === "PUT" &&
        new URL(request.url()).pathname.startsWith("/api/trade-wants/")
      )
        writes.push(request.postDataJSON().rule);
    });

    // Held PUT: the radio group already shows the new choice, and the stored one hasn't changed.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const held = (url: URL) =>
      url.pathname === `/api/trade-wants/will-accept/${ids["SVE 13"]}`;
    await page.route(held, async (route) => {
      await gate;
      await route.continue();
    });
    await energy(page)
      .getByRole("radio", { name: "Any finish", exact: true })
      .check();
    await expect(energy(page)).toHaveAttribute("aria-disabled", "true");
    await expect(
      energy(page).getByRole("radio", { name: "Any finish", exact: true })
    ).toBeChecked();
    expect((await tradeWants(page)).rules).toEqual({});
    await expect.poll(() => writes).toEqual(["printing"]);
    await expect(printing).toHaveAttribute("aria-disabled", "true");
    await expect(identity).toHaveAttribute("aria-disabled", "true");
    // Force bypasses Playwright's aria-disabled actionability guard, so the label actually receives the click.
    await identity.locator("..").click({ force: true });
    await expect(printing).toBeChecked();
    await expect(identity).not.toBeChecked();
    await printing.focus();
    await printing.press("ArrowDown");
    await expect(printing).toBeChecked();
    await identity.focus();
    await identity.press("Space");
    await expect(printing).toBeChecked();
    await expect(identity).not.toBeChecked();
    await expect(group).toHaveAttribute("aria-disabled", "true");
    // Flush browser event handling before sampling the no-additional-write invariant.
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    );
    expect(writes).toEqual(["printing"]);
    expect((await tradeWants(page)).rules).toEqual({});
    release();
    await expect(notifications(page)).toContainText(/^Trades will match any/);
    await expect(
      energy(page).getByRole("radio", { name: "Any finish", exact: true })
    ).toBeChecked();
    await expect(group).not.toHaveAttribute("aria-disabled", "true");
    await page.unroute(held);

    // Clicking or pressing Space on the saved choice is a no-op.
    await printing.locator("..").click();
    await printing.focus();
    await printing.press("Space");
    await expect(printing).toBeChecked();
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    );
    expect(writes).toEqual(["printing"]);

    // A failed PUT puts the saved choice back.
    await page.route(held, (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ detail: { code: "INTERNAL" } }),
      })
    );
    await energy(page)
      .getByRole("radio", { name: "This exact card", exact: true })
      .check();
    await expect(notifications(page)).toContainText(
      "That choice couldn't be saved. Please try again."
    );
    await expect(
      energy(page).getByRole("radio", { name: "Any finish", exact: true })
    ).toBeChecked();
    expect((await tradeWants(page)).rules).toEqual({
      [ids["SVE 13"]]: "printing",
    });
    await expect(group).not.toHaveAttribute("aria-disabled", "true");
    expect(writes).toEqual(["printing", "edition"]);
    await page.unroute(held);

    // After rollback, ordinary native arrow-key navigation saves the next choice.
    await printing.focus();
    await printing.press("ArrowDown");
    await expect(identity).toBeChecked();
    await expect(notifications(page)).toContainText(
      /^Trades will match any card with the same name/
    );
    await expect(group).not.toHaveAttribute("aria-disabled", "true");
    expect((await tradeWants(page)).rules).toEqual({
      [ids["SVE 13"]]: "identity",
    });
    expect(writes).toEqual(["printing", "edition", "identity"]);
  });

  test("the Trade Wants panel is not part of a one-Deck Want List", async ({
    page,
  }) => {
    const ids = seedCatalog();
    await signIn(page);
    const deck = await createDeck(page, `Deck ${randomUUID().slice(0, 6)}`, 1);
    await setLine(page, deck, ids["SVE 13"], 1);
    await page.goto(`${ORIGIN}/decks/want-list`);
    await expect(panel(page)).toBeVisible();
    await page.goto(`${ORIGIN}/decks/want-list?deck=${deck}`);
    await expect(energy(page)).toHaveCount(1);
    await expect(panel(page)).toHaveCount(0);
  });

  test("the picker shows more results with Show more until no page remains", async ({
    page,
  }) => {
    seedCatalog();
    await signIn(page);
    await page.goto(`${ORIGIN}/decks/want-list`);
    // The catalog is small, so the first page is answered with a cursor and the second page is another search's rows.
    await page.route(
      (url) => url.pathname === "/api/catalog/editions",
      async (route) => {
        const url = new URL(route.request().url());
        if (url.searchParams.has("cursor")) {
          url.searchParams.delete("cursor");
          url.searchParams.set("q", "Boss");
          const second = await route.fetch({ url: url.toString() });
          await route.fulfill({
            response: second,
            json: { ...(await second.json()), next_cursor: null },
          });
        } else {
          const first = await route.fetch();
          await route.fulfill({
            response: first,
            json: { ...(await first.json()), next_cursor: "more" },
          });
        }
      }
    );
    await panel(page).getByRole("button", { name: "Add a card" }).click();
    await picker(page)
      .getByRole("searchbox", { name: "Search by card name" })
      .fill("Iono");
    await expect(
      picker(page).getByRole("list", { name: "Iono" }).getByRole("listitem")
    ).toHaveCount(3);
    await expect(picker(page).getByRole("list", { name: /^Boss/ })).toHaveCount(
      0
    );
    const more = picker(page).getByRole("button", { name: "Show more" });
    await more.click();
    await expect(picker(page).getByRole("list", { name: /^Boss/ })).toHaveCount(
      1
    );
    await expect(
      picker(page).getByRole("list", { name: "Iono" }).getByRole("listitem")
    ).toHaveCount(3);
    await expect(more).toHaveCount(0);
  });

  test("a Show more page that arrives after the search changed is dropped", async ({
    page,
  }) => {
    seedCatalog();
    await signIn(page);
    await page.goto(`${ORIGIN}/decks/want-list`);
    // Every first page offers Show more; the second page is held until the search has changed, then answers Boss rows.
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    await page.route(
      (url) => url.pathname === "/api/catalog/editions",
      async (route) => {
        const url = new URL(route.request().url());
        if (url.searchParams.has("cursor")) {
          await released;
          url.searchParams.delete("cursor");
          url.searchParams.set("q", "Boss");
          const second = await route.fetch({ url: url.toString() });
          await route.fulfill({
            response: second,
            json: { ...(await second.json()), next_cursor: null },
          });
        } else {
          const first = await route.fetch();
          await route.fulfill({
            response: first,
            json: { ...(await first.json()), next_cursor: "more" },
          });
        }
      }
    );
    await panel(page).getByRole("button", { name: "Add a card" }).click();
    const search = picker(page).getByRole("searchbox", {
      name: "Search by card name",
    });
    await search.fill("Iono");
    await expect(
      picker(page).getByRole("list", { name: "Iono" }).getByRole("listitem")
    ).toHaveCount(3);
    await picker(page).getByRole("button", { name: "Show more" }).click();
    await search.fill("Arven");
    await expect(
      picker(page).getByRole("list", { name: "Arven" })
    ).toBeVisible();
    await expect(picker(page).getByRole("list", { name: "Iono" })).toHaveCount(
      0
    );
    // Release the held page, wait for it to arrive and for a frame to render, then check it was dropped.
    const stale = page.waitForResponse(
      (r) =>
        r.url().includes("/api/catalog/editions") && r.url().includes("cursor=")
    );
    release();
    await stale;
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    );
    await expect(picker(page).getByRole("list", { name: /^Boss/ })).toHaveCount(
      0
    );
    await expect(
      picker(page).getByRole("button", { name: "Show more" })
    ).toBeVisible();
    await expect(
      picker(page).getByRole("list", { name: "Arven" })
    ).toBeVisible();
  });
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

  test("the Trade Wants panel, the picker and Will accept fit a phone, and nothing scrolls sideways", async ({
    page,
  }) => {
    test.slow();
    const ids = seedCatalog();
    await signIn(page);
    const deck = await createDeck(page, `Deck ${randomUUID().slice(0, 6)}`, 1);
    await setLine(page, deck, ids["SVE 13"], 1);
    await page.goto(`${ORIGIN}/decks/want-list`);
    await expectTouchTarget(energy(page).locator("label").first());
    await expectTouchTarget(
      panel(page).getByRole("button", { name: "Add a card" })
    );

    await addIono(page);
    await expect(notifications(page)).toContainText("Added to Trade Wants");
    await expectTouchTarget(
      picker(page).getByRole("button", {
        name: /^Add Iono \(Paldea Evolved · 254 /,
      })
    );
    await expectPageChecks(page, "the Add a card picker on a phone");
    await picker(page).getByRole("button", { name: "Done" }).tap();
    const decrease = panel(page).getByRole("button", {
      name: /^Decrease Iono \(Paldea Evolved · 254 /,
    });
    await expectTouchTarget(decrease);
    await expectPageChecks(page, "the Trade Wants panel on a phone");
    await decrease.tap();
    await expect(panel(page)).toContainText("No Trade Wants yet.");
  });
});
