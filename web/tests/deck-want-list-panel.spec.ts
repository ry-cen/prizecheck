import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { startAsNewOwner } from "./support/owner";
import { expectPageChecks } from "./support/page-check";
import { signInAsOwner } from "./support/sign-in";

// The deck builder's finish-deck flow. Under row 1's cost, four counts add up to the Deck List: In this Deck, Owned
// elsewhere, Lent out and Not owned. While a copy is missing from the Deck, Ways to get missing cards opens the Deck's
// Want List lines in place, with the Want List's own Swap, Undo, Will accept and Friend chips. The panel stays mounted
// once opened, collapsed or not and after the Deck is complete, so a Swap's Undo outlives both. The catalog
// (api/tests/want_list_swap_fixtures.py) has Iono PAL 185 and PAL 254 in one Reprint Group.

const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

type Editions = { "PAL 185": string; "PAL 254": string };

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

/**
 * A Deck whose one missing card a Swap completes: it holds one PAL 254 beyond its Deck List (a Spare Copy) and lists
 * one Iono PAL 185, which it doesn't hold.
 */
async function lastGap(page: Page, ids: Editions) {
  const name = `Finish ${randomUUID().slice(0, 6)}`;
  const created = await api(page, "POST", "/api/decks", {
    name,
    idempotency_key: randomUUID(),
  });
  const deck = created.location.id as string;
  // A copy arriving in a Deck lists it (migration 031); taking the line off leaves the copy as surplus.
  await api(page, "POST", "/api/holdings", {
    location_id: deck,
    edition_id: ids["PAL 254"],
    quantity: "1",
    idempotency_key: randomUUID(),
  });
  await setLine(page, deck, ids["PAL 254"], 0);
  await setLine(page, deck, ids["PAL 185"], 1);
  return { name, deck };
}

const readiness = (page: Page) =>
  page.getByRole("group", { name: "Where this Deck's cards are" });
const toggle = (page: Page) =>
  page.getByRole("button", { name: "Ways to get missing cards" });
const panel = (page: Page) =>
  page.getByRole("region", { name: "Ways to get missing cards" });
const notifications = (page: Page) =>
  page.getByRole("region", { name: "Notifications" });
const swapButton = (page: Page) =>
  page.getByRole("button", {
    name: "Swap 1 Iono Paldea Evolved 185 for PAL 254",
  });

test.afterAll(async () => {
  await pool.end();
});

test.describe("on a desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("the four counts add up, the panel's Swap completes the Deck, and its Undo survives the panel collapsing and the Deck completing", async ({
    page,
  }) => {
    const ids = seedCatalog();
    await signIn(page);
    const { name, deck } = await lastGap(page, ids);
    await page.goto(`${ORIGIN}/decks/${deck}`);

    await expect(readiness(page)).toContainText("In this Deck0");
    await expect(readiness(page)).toContainText("Owned elsewhere0");
    await expect(readiness(page)).toContainText("Lent out0");
    await expect(readiness(page)).toContainText("Not owned1");
    // The Want List keeps its own page and row 1's actions keep their names.
    await expect(
      page.getByRole("button", { name: "Want List", exact: true })
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Buy missing", exact: true })
    ).toBeVisible();

    // Nothing is read until the panel opens.
    await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
    await expect(panel(page)).toBeHidden();
    await toggle(page).click();
    await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");
    await expect(panel(page)).toContainText(
      "Counted as Every Deck built at once."
    );
    const needs = panel(page)
      .getByRole("list", { name: `What ${name} needs` })
      .getByRole("listitem");
    await expect(needs).toHaveCount(1);
    await expect(needs).toContainText("1 of 1");
    await expectPageChecks(
      page,
      "the deck builder's Ways to get missing cards"
    );

    // The Swap completes the Deck: the readiness says so, and the panel stays with nothing to get.
    await swapButton(page).click();
    await expect(notifications(page)).toContainText(
      `Swapped 1 Iono for PAL 254 in ${name}.`
    );
    await expect(page.getByText("Every card is in this Deck.")).toBeVisible();
    await expect(panel(page)).toContainText(
      "Nothing to get, counted as Every Deck built at once."
    );
    expect(await deckList(page, deck)).toEqual({ [ids["PAL 254"]]: "1" });

    // Collapsing keeps the panel mounted, so the toast's Undo stays.
    await toggle(page).click();
    await expect(panel(page)).toBeHidden();
    const undo = notifications(page).getByRole("button", { name: "Undo" });
    await expect(undo).toBeVisible();
    await undo.click();
    await expect(notifications(page)).toContainText(
      `Undone: Swapped 1 Iono for PAL 254 in ${name}.`
    );
    // The builder reads the Deck again: the counts and the reopened panel follow the restored Deck List.
    await expect(readiness(page)).toContainText("Not owned1");
    expect(await deckList(page, deck)).toEqual({ [ids["PAL 185"]]: "1" });
    await toggle(page).click();
    await expect(needs).toContainText("1 of 1");
    await expect(swapButton(page)).toBeVisible();
  });
});
