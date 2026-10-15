import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { Pool } from "pg";
import { startAsNewOwner } from "./support/owner";
import { signInAsOwner } from "./support/sign-in";

// Deck figures follow the Want List counting setting (decklist import #208). The spec's worked example on one Edition:
// Charizard ex (older) lists 4 and holds 1, Gardevoir ex (newer) lists 2 and holds none, and one copy is loose on a
// Shelf. Under Every Deck built at once (the default) the older Deck takes the loose copy, so the newer one needs both
// of its copies; under One Deck at a time it counts the older Deck's copy and the loose one and needs none. The deck
// builder's "to complete", Buy missing and the Decks index row change with the setting on their next read; Gather
// doesn't. Prices are real cached quotes (fresh, so no refresh waits), as in workspace-deck-heading.spec.ts.

const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

/** Runs Python against the live stack's database, passing `argument` as a JSON file. */
function python(code: string, argument: object = {}): string {
  const path = `${process.env.TMPDIR || "/tmp"}/deck-counting-${randomUUID()}.json`;
  writeFileSync(path, JSON.stringify(argument));
  return execFileSync(".venv/bin/python", ["-c", code, path], {
    env: { ...process.env, PYTHONPATH: "api:api/tests" },
    maxBuffer: 64 * 1024 * 1024,
  }).toString();
}

/** The price spec's catalog; the normal Edition stands in for Iono PAL 185, with a fresh $0.25 quote. */
function ionoEdition(): string {
  const out = python(`import json
from test_prices import ui_world
print('WORLD' + json.dumps(ui_world(0)))`);
  const ids = JSON.parse(out.slice(out.lastIndexOf("WORLD") + 5)) as {
    normal: string;
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
  return ids.normal;
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

async function createDeck(page: Page, name: string, daysAgo: number) {
  const created = await api(page, "POST", "/api/decks", {
    name,
    idempotency_key: randomUUID(),
  });
  const id = created.location.id as string;
  // Creation time decides which Deck counts a spare copy first; set it so the order never depends on timing.
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

const costLine = (page: Page) => page.getByText(/ to complete/);
const buyMissing = (page: Page) =>
  page.getByRole("button", { name: "Buy missing", exact: true });
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

test("a newer Deck's to complete and Buy missing follow the counting setting, and Gather doesn't", async ({
  page,
}) => {
  const iono = ionoEdition();
  await signIn(page);
  const suffix = randomUUID().slice(0, 6);
  const older = `Charizard ex ${suffix}`;
  const newer = `Gardevoir ex ${suffix}`;
  const olderId = await createDeck(page, older, 2);
  const newerId = await createDeck(page, newer, 1);
  await hold(page, olderId, iono, 1); // a copy arriving in a Deck lists it (migration 031)
  await setLine(page, olderId, iono, 4);
  await setLine(page, newerId, iono, 2);
  const shelf = await api(page, "POST", "/api/location-tree", {
    name: `Shelf ${suffix}`,
    parent_id: null,
    parent_version: null,
    idempotency_key: randomUUID(),
  });
  await hold(page, shelf.location.id, iono, 1);

  // Every Deck built at once (the default): the newer Deck needs both copies.
  await page.goto(`${ORIGIN}/decks/${newerId}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(newer);
  await expect(costLine(page)).toHaveText(
    "$0.50 deck (2/2 priced) · $0.50 to complete (2/2 priced)"
  );
  await expect(buyMissing(page)).toBeEnabled();
  // Gather offers the older Deck's copy and the loose one whatever the setting.
  await expect(page.getByRole("button", { name: "Gather 2" })).toBeEnabled();
  await buyMissing(page).click();
  const dialog = page.getByRole("dialog", { name: "Export" });
  await expect(
    dialog.getByRole("radio", { name: "Cards you don't own (2)" })
  ).toBeChecked();
  await dialog.getByRole("button", { name: "Close export" }).click();

  await page.goto(`${ORIGIN}/decks`);
  await expect(indexRow(page, newer)).toContainText(
    "$0.50 to complete (2/2 priced)"
  );
  await expect(indexRow(page, older)).toContainText(
    "$0.50 to complete (2/2 priced)"
  );

  // One Deck at a time, chosen on Settings.
  await page.goto(`${ORIGIN}/settings`);
  await page
    .getByRole("group", { name: "Want List counting" })
    .getByRole("radio", { name: "One Deck at a time" })
    .click();
  await expect(
    page.getByRole("region", { name: "Decks" }).getByRole("status")
  ).toHaveText("Want List counting set to One Deck at a time.");

  await page.goto(`${ORIGIN}/decks`);
  await expect(indexRow(page, newer)).toContainText("$0.00 to complete");
  await expect(indexRow(page, older)).toContainText(
    "$0.50 to complete (2/2 priced)"
  );
  await page.goto(`${ORIGIN}/decks/${newerId}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(newer);
  await expect(costLine(page)).toHaveText(
    "$0.50 deck (2/2 priced) · $0.00 to complete"
  );
  await expect(buyMissing(page)).toBeDisabled();
  await expect(page.getByRole("button", { name: "Gather 2" })).toBeEnabled();
});
