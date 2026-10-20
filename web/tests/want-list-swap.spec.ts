import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { startAsNewOwner } from "./support/owner";
import { expectPageChecks } from "./support/page-check";
import { signInAsOwner } from "./support/sign-in";
import { expectTouchTarget } from "./support/touch-target";

// Swap from the Want List (decklist import #211). The catalog (api/tests/want_list_swap_fixtures.py) has Iono PAL 185,
// PAL 254 and PAF 80 in one Reprint Group. A line that still needs copies says "↻ You own a playable version (PAL 254)
// × 1" when another Edition of its group has copies the counting setting makes available; Swap sends one Deck List
// changes batch that moves that many copies onto a line for the owned Edition, every count follows, and the toast's
// Undo sends the inverse batch. A Swap or an Undo after the list changed elsewhere is refused and the page reads again.
// Will accept (Trading #275) widens the hint: Basic Psychic Energy SVE 13 and SVE 5 share a name and no Reprint Group, so
// with "Any card with the same name" a line needing SVE 13 says "↻ You own a card with the same name (sve 005) × 2" for
// two spare SVE 5 (their set has no printed code, so the hint names it by its set ID).

const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";
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
  // Creation time decides which Deck counts a spare copy first; set it so it never depends on timing.
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

/** The Deck List as {Edition id: quantity}. */
async function deckList(page: Page, deckId: string) {
  const detail = await api(page, "GET", `/api/decks/${deckId}`);
  return Object.fromEntries(
    (detail.deck_list.lines as { edition_id: string; quantity: string }[]).map(
      (line) => [line.edition_id, line.quantity]
    )
  );
}

async function shelf(page: Page) {
  const created = await api(page, "POST", "/api/location-tree", {
    name: `Shelf ${randomUUID().slice(0, 6)}`,
    parent_id: null,
    parent_version: null,
    idempotency_key: randomUUID(),
  });
  return created.location.id as string;
}

/** The spec's example: a Deck listing 4 Iono PAL 185 and holding none, and one loose PAL 254 on a Shelf. */
async function example(page: Page, ids: Editions) {
  const name = `Charizard ex ${randomUUID().slice(0, 6)}`;
  const deck = await createDeck(page, name, 1);
  await setLine(page, deck, ids["PAL 185"], 4);
  await hold(page, await shelf(page), ids["PAL 254"], 1);
  return { name, deck };
}

const needs = (page: Page, name: string) =>
  page.getByRole("list", { name: `What ${name} needs` }).getByRole("listitem");
const notifications = (page: Page) =>
  page.getByRole("region", { name: "Notifications" });
const hintText = "↻ You own a playable version (PAL 254) × 1";
const swapButton = (page: Page) =>
  page.getByRole("button", {
    name: "Swap 1 Iono Paldea Evolved 185 for PAL 254",
  });

/** Trading #275's example: a Deck listing 4 Basic Psychic Energy SVE 13 and two loose SVE 5 on a Shelf. */
async function sameName(page: Page, ids: Editions) {
  const name = `Gardevoir ex ${randomUUID().slice(0, 6)}`;
  const deck = await createDeck(page, name, 1);
  await setLine(page, deck, ids["SVE 13"], 4);
  await hold(page, await shelf(page), ids["SVE 5"], 2);
  return { name, deck };
}

const willAccept = (page: Page) =>
  page.getByRole("combobox", {
    name: /^Will accept for Basic Psychic Energy \(Scarlet & Violet Energies · 013 /,
  });
const sameNameHint = "↻ You own a card with the same name (sve 005) × 2";
const energySwap = (page: Page) =>
  page.getByRole("button", {
    name: "Swap 2 Basic Psychic Energy Scarlet & Violet Energies 013 for sve 005",
  });

test.afterAll(async () => {
  await pool.end();
});

test.describe("on a desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("Swap moves the spare copy onto a line for the owned Edition, every count follows, and Undo puts the Deck List back", async ({
    page,
  }) => {
    const ids = seedCatalog();
    await signIn(page);
    const { name, deck } = await example(page, ids);
    await page.goto(`${ORIGIN}/decks/want-list`);

    await expect(needs(page, name)).toHaveCount(1);
    await expect(needs(page, name)).toContainText("4 of 4");
    await expect(needs(page, name)).toContainText(hintText);
    await expect(page.getByText("4 cards", { exact: true })).toBeVisible();
    // #210's cost follows the answer on the page: these Editions have no price.
    await expect(page.getByText("0/4 cards priced")).toBeVisible();
    await expectPageChecks(page, "the Want List with a Swap hint");

    // 4 Iono PAL 185 with one spare PAL 254 becomes 3 PAL 185 and 1 PAL 254.
    await swapButton(page).click();
    await expect(notifications(page)).toContainText(
      `Swapped 1 Iono for PAL 254 in ${name}.`
    );
    // The line's Swap leaves the page, so the toast's Undo takes the focus.
    await expect(
      notifications(page).getByRole("button", { name: "Undo" })
    ).toBeFocused();
    await expect(needs(page, name)).toHaveCount(1);
    await expect(needs(page, name)).toContainText("3 of 3");
    await expect(page.getByText(/You own a playable version/)).toHaveCount(0);
    await expect(page.getByText("3 cards", { exact: true })).toBeVisible();
    // The re-read moves the Deck List digest, so the cost is read again for the new answer.
    await expect(page.getByText("0/3 cards priced")).toBeVisible();
    expect(await deckList(page, deck)).toEqual({
      [ids["PAL 185"]]: "3",
      [ids["PAL 254"]]: "1",
    });

    // Undo is the inverse batch: the PAL 254 line goes and PAL 185 is 4 again, with its hint.
    await notifications(page).getByRole("button", { name: "Undo" }).click();
    await expect(notifications(page)).toContainText(
      `Undone: Swapped 1 Iono for PAL 254 in ${name}.`
    );
    await expect(needs(page, name)).toContainText("4 of 4");
    await expect(needs(page, name)).toContainText(hintText);
    await expect(page.getByText("0/4 cards priced")).toBeVisible();
    expect(await deckList(page, deck)).toEqual({ [ids["PAL 185"]]: "4" });
  });

  test("the hint follows the counting setting: a copy sleeved in another Deck is offered only under One Deck at a time", async ({
    page,
  }) => {
    const ids = seedCatalog();
    await signIn(page);
    const suffix = randomUUID().slice(0, 6);
    const keeper = await createDeck(page, `Keeper ${suffix}`, 2);
    const wanting = `Wanting ${suffix}`;
    const wantingId = await createDeck(page, wanting, 1);
    await hold(page, keeper, ids["PAL 254"], 1); // a copy arriving in a Deck lists it (migration 031)
    await setLine(page, wantingId, ids["PAL 185"], 2);

    // Every Deck built at once: the copy Keeper holds for its own line is never offered to Wanting.
    await page.goto(`${ORIGIN}/decks/want-list`);
    await expect(needs(page, wanting)).toContainText("2 of 2");
    await expect(needs(page, wanting)).toContainText("None owned");
    await expect(page.getByText(/You own a playable version/)).toHaveCount(0);

    // One Deck at a time: every copy outside Wanting counts, the one sleeved in Keeper too.
    const settings = await api(page, "GET", "/api/settings");
    await api(page, "PUT", "/api/settings/want-list-counting", {
      want_list_counting: "one_at_a_time",
      revision: settings.revision,
      idempotency_key: randomUUID(),
    });
    await page.reload();
    await expect(page.getByText("Counting: One Deck at a time.")).toBeVisible();
    await expect(needs(page, wanting)).toContainText(hintText);
    await page
      .getByRole("button", {
        name: "Swap 1 Iono Paldea Evolved 185 for PAL 254",
      })
      .click();
    await expect(needs(page, wanting)).toContainText("1 of 1");
    expect(await deckList(page, wantingId)).toEqual({
      [ids["PAL 185"]]: "1",
      [ids["PAL 254"]]: "1",
    });
  });

  test("the Swap buttons stay disabled until the Want List is read again", async ({
    page,
  }) => {
    const ids = seedCatalog();
    await signIn(page);
    const { name } = await example(page, ids);
    await page.goto(`${ORIGIN}/decks/want-list`);
    await expect(needs(page, name)).toContainText(hintText);

    // Hold the re-read after the Swap: the old list stays drawn meanwhile.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route(
      (url) => url.pathname === "/api/want-list",
      async (route) => {
        await gate;
        await route.continue();
      }
    );
    await swapButton(page).click();
    await expect(notifications(page)).toContainText(
      `Swapped 1 Iono for PAL 254 in ${name}.`
    );
    await expect(swapButton(page)).toHaveAttribute("aria-disabled", "true");
    release();
    await expect(needs(page, name)).toContainText("3 of 3");
    await expect(swapButton(page)).toHaveCount(0);
  });

  test("a Swap or an Undo after the Deck List changed elsewhere is refused and the page reads it again", async ({
    page,
  }) => {
    const ids = seedCatalog();
    await signIn(page);
    const { name, deck } = await example(page, ids);
    await page.goto(`${ORIGIN}/decks/want-list`);
    await expect(needs(page, name)).toContainText(hintText);

    // Another tab lowers the line after the page read it: the Swap is refused and nothing moves.
    await expect(page.getByText("0/4 cards priced")).toBeVisible();
    await setLine(page, deck, ids["PAL 185"], 2);
    await swapButton(page).click();
    await expect(page.getByRole("status").filter({ hasText: name })).toHaveText(
      `${name} changed somewhere else, so nothing was swapped. The Want List is up to date now.`
    );
    await expect(needs(page, name)).toContainText("2 of 2");
    await expect(needs(page, name)).toContainText(hintText);
    expect(await deckList(page, deck)).toEqual({ [ids["PAL 185"]]: "2" });

    // Swap on the fresh read, then an edit before Undo: the Undo is refused.
    await swapButton(page).click();
    await expect(notifications(page)).toContainText(
      `Swapped 1 Iono for PAL 254 in ${name}.`
    );
    await expect(needs(page, name)).toContainText("1 of 1");
    await setLine(page, deck, ids["PAF 80"], 1);
    await notifications(page).getByRole("button", { name: "Undo" }).click();
    await expect(notifications(page)).toContainText(
      "Can't undo: this deck changed."
    );
    expect(await deckList(page, deck)).toEqual({
      [ids["PAL 185"]]: "1",
      [ids["PAL 254"]]: "1",
      [ids["PAF 80"]]: "1",
    });
  });

  test("Any card with the same name offers an owned spare in no Reprint Group, and Swap takes it", async ({
    page,
  }) => {
    const ids = seedCatalog();
    await signIn(page);
    const { name, deck } = await sameName(page, ids);
    await page.goto(`${ORIGIN}/decks/want-list`);
    await expect(needs(page, name)).toContainText("4 of 4");
    // This exact card, the default: the Energy is in no Reprint Group, so there is no hint.
    await expect(willAccept(page)).toHaveValue("edition");
    await expect(page.getByText(/You own a/)).toHaveCount(0);

    await willAccept(page).selectOption({
      label: "Any card with the same name",
    });
    await expect(needs(page, name)).toContainText(sameNameHint);
    // The choice changes no figure: the Deck still needs 4.
    await expect(needs(page, name)).toContainText("4 of 4");
    await expect(page.getByText("4 cards", { exact: true })).toBeVisible();
    await expectPageChecks(page, "the Want List with a same-name Swap hint");

    await energySwap(page).click();
    await expect(notifications(page)).toContainText(
      `Swapped 2 Basic Psychic Energy for sve 005 in ${name}.`
    );
    await expect(needs(page, name)).toContainText("2 of 2");
    await expect(page.getByText(/You own a/)).toHaveCount(0);
    expect(await deckList(page, deck)).toEqual({
      [ids["SVE 13"]]: "2",
      [ids["SVE 5"]]: "2",
    });
  });
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

  test("the hint and Swap fit a phone, and nothing scrolls sideways", async ({
    page,
  }) => {
    const ids = seedCatalog();
    await signIn(page);
    const { name } = await example(page, ids);
    await page.goto(`${ORIGIN}/decks/want-list`);
    await expect(needs(page, name)).toContainText(hintText);
    await expectTouchTarget(swapButton(page));
    await expectPageChecks(page, "the Want List with a Swap hint on a phone");
    await swapButton(page).tap();
    await expect(needs(page, name)).toContainText("3 of 3");
    await expect(
      notifications(page).getByRole("button", { name: "Undo" })
    ).toBeVisible();
  });

  test("Will accept and the same-name hint fit a phone, and Swap takes the spare", async ({
    page,
  }) => {
    const ids = seedCatalog();
    await signIn(page);
    const { name } = await sameName(page, ids);
    await page.goto(`${ORIGIN}/decks/want-list`);
    await expectTouchTarget(willAccept(page));
    await willAccept(page).selectOption({
      label: "Any card with the same name",
    });
    await expect(needs(page, name)).toContainText(sameNameHint);
    await expectTouchTarget(energySwap(page));
    await expectPageChecks(
      page,
      "the Want List with a same-name Swap hint on a phone"
    );
    await energySwap(page).tap();
    await expect(needs(page, name)).toContainText("2 of 2");
  });
});
