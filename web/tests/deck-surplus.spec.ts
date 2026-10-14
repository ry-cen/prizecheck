import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { expectPageChecks } from "./support/page-check";
import { listCards } from "./support/deck-list";
import { startAsNewOwner } from "./support/owner";

// Surplus and the competition warning (#180): copies physically in a Deck but cut from its Deck List show in their own
// group in every view, and Put away moves them to a Location the collector picks as one Move with an Undo toast. A
// warning names the other Decks whose Deck Lists count the same spare copies.

const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";
const OWNER_EMAIL = process.env.OWNER_EMAIL || "owner@example.test";

// A 1×1 PNG stands in for card artwork, so no test reaches the network.
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64"
);

/** Replaces the catalog with three cards through the real import. This also clears every Holding. */
function promoteCatalog() {
  execFileSync(
    ".venv/bin/python",
    [
      "-c",
      `from test_catalog_search import promote
promote({'card-1': 'Charmander', 'card-2': 'Pikachu', 'card-3': 'Ultra Ball'})`,
    ],
    { env: { ...process.env, PYTHONPATH: "api:api/tests" } }
  );
}

function messages(path: string): string[] {
  try {
    return readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
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
  const mail = process.env.MAIL_FILE || "/tmp/tcg-ticket01-mail";
  const before = messages(mail).length;
  await page.goto(`${ORIGIN}/collection`);
  await page.getByLabel("Email").fill(OWNER_EMAIL);
  await page.getByRole("button", { name: "Send code" }).click();
  await expect.poll(() => messages(mail).length).toBeGreaterThan(before);
  await page
    .getByLabel("Six-digit code")
    .fill(JSON.parse(messages(mail).at(-1)!).otp);
  await page.getByRole("button", { name: "Sign in" }).click();
  // Signed out, /collection shows the sign-in card at the same address, so wait for the shell.
  await expect(
    page.getByRole("navigation", { name: "Main views" })
  ).toBeVisible();
}

async function send(
  page: Page,
  method: "post" | "patch" | "delete",
  path: string,
  data: object
) {
  const response = await page.request[method](`${ORIGIN}${path}`, {
    headers: { origin: ORIGIN },
    data,
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

async function get(page: Page, path: string) {
  const response = await page.request.get(`${ORIGIN}${path}`);
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
  boxId: string;
  boxName: string;
  keeperName: string;
  rivalName: string;
  editions: { charmander: string; pikachu: string; ultraBall: string };
};

/**
 * A Deck with a 3-card Deck List and 5 surplus copies: it holds Charmander 4 (listed 1, so 3 surplus) and Pikachu 2
 * (its line removed, so 2 surplus), and lists Ultra Ball 2 that it doesn't hold. The one loose Ultra Ball is in the
 * Box; Keeper holds another for its own Deck List, and Rival lists 1 it doesn't hold. So this Deck and Rival count 3
 * Ultra Balls as owned elsewhere while only 1 is spare: the competition warning names Keeper and Rival.
 */
async function buildDeck(page: Page): Promise<Built> {
  const suffix = randomUUID().slice(0, 6);
  const deckName = `Surplus ${suffix}`;
  const keeperName = `Keeper ${suffix}`;
  const rivalName = `Rival ${suffix}`;
  const boxName = `Box ${suffix}`;
  const deck = async (name: string) =>
    (
      await send(page, "post", "/api/decks", {
        name,
        idempotency_key: randomUUID(),
      })
    ).location.id as string;
  const deckId = await deck(deckName);
  const keeperId = await deck(keeperName);
  const rivalId = await deck(rivalName);
  const boxId = (
    await send(page, "post", "/api/location-tree", {
      name: boxName,
      parent_id: null,
      parent_version: null,
      idempotency_key: randomUUID(),
    })
  ).location.id as string;
  const editions = {
    charmander: await editionOf("card-1"),
    pikachu: await editionOf("card-2"),
    ultraBall: await editionOf("card-3"),
  };
  const hold = (location: string, edition: string, quantity: number) =>
    send(page, "post", "/api/holdings", {
      location_id: location,
      edition_id: edition,
      quantity: String(quantity),
      idempotency_key: randomUUID(),
    });
  // Copies arriving in a Deck join its Deck List (migration 031): this Deck lists Charmander 4 and Pikachu 2, and
  // Keeper lists its Ultra Ball.
  await hold(deckId, editions.charmander, 4);
  await hold(deckId, editions.pikachu, 2);
  await hold(keeperId, editions.ultraBall, 1);
  await hold(boxId, editions.ultraBall, 1);
  // Cut the Deck List through its commands; cutting never moves cards, so the cut copies stay as surplus.
  const revision = async () =>
    (await get(page, `/api/decks/${deckId}`)).deck_list.revision as number;
  const lines = `/api/decks/${deckId}/deck-list/lines`;
  await send(page, "patch", `${lines}/${editions.charmander}`, {
    quantity: "1",
    revision: await revision(),
    idempotency_key: randomUUID(),
  });
  await send(page, "delete", `${lines}/${editions.pikachu}`, {
    revision: await revision(),
    idempotency_key: randomUUID(),
  });
  const [{ owner_id: owner }] = await query<{ owner_id: string }>(
    "SELECT owner_id FROM location WHERE id=$1",
    [deckId]
  );
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await listCards(pool, owner, deckId, { [editions.ultraBall]: 2 });
    await listCards(pool, owner, rivalId, { [editions.ultraBall]: 1 });
  } finally {
    await pool.end();
  }
  return {
    deckId,
    deckName,
    boxId,
    boxName,
    keeperName,
    rivalName,
    editions,
  };
}

const edition = (number: string) => `Fixture Set · ${number} · Normal`;
const surplusCopy = (name: string, number: string, rest: string) =>
  `${name}, ${edition(number)}, ${rest}: in this Deck, not on the Deck List`;
const surplusPile = (name: string, number: string, copies: string) =>
  `${name}, ${edition(number)}: ${copies} surplus, in this Deck, not on the Deck List`;

async function expectWarning(page: Page, built: Built) {
  const warning = page.getByRole("group", {
    name: "Other Decks count the same spare copies",
  });
  await expect(warning).toContainText(
    `Ultra Ball · ${edition("3")}: 3 copies are counted as owned elsewhere, but only 1 is spare.`
  );
  await expect(warning.getByRole("listitem")).toContainText([
    `${built.keeperName} holds 1 for its own Deck List.`,
    `${built.rivalName} also counts 1 as owned elsewhere.`,
  ]);
}

test.describe("on a desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("surplus shows in every view and Put away is one Move with Undo; the warning names the other Decks", async ({
    page,
  }) => {
    promoteCatalog();
    await signIn(page);
    const built = await buildDeck(page);
    await page.goto(`${ORIGIN}/decks/${built.deckId}`);

    const deckList = page.getByRole("region", { name: "Deck List" });
    // Surplus never counts toward the Deck List.
    await expect(deckList).toContainText("3/60");
    await expectWarning(page, built);

    // Spread: one tile per surplus copy.
    const surplus = page.getByRole("region", {
      name: "Surplus, 5 cards",
      exact: true,
    });
    await expect(
      surplus.getByRole("heading", {
        level: 3,
        name: "Surplus, 5 cards",
        exact: true,
      })
    ).toHaveText("Surplus, 5 cards");
    await expect(page.getByRole("radio", { name: "Spread" })).toBeChecked();
    await expect(
      surplus.getByRole("button", {
        name: surplusCopy("Charmander", "1", "surplus copy 3 of 3"),
        exact: true,
      })
    ).toBeVisible();
    await expect(
      surplus.getByRole("button", { name: /^Pikachu, / })
    ).toHaveCount(2);
    await expectPageChecks(page, "deck surplus, Spread");

    // Stacked: one pile per Edition.
    await page.getByRole("radio", { name: "Stacked" }).click();
    await expect(
      surplus.getByRole("button", {
        name: surplusPile("Charmander", "1", "3 copies"),
        exact: true,
      })
    ).toContainText("×3");
    await expectPageChecks(page, "deck surplus, Stacked");

    // List: one row per Edition. Pressing a card opens Put away for that card alone; Escape returns focus to it.
    await page.getByRole("radio", { name: "List" }).click();
    const pikachu = surplus.getByRole("button", {
      name: surplusPile("Pikachu", "2", "2 copies"),
      exact: true,
    });
    await expect(pikachu).toBeVisible();
    await expectPageChecks(page, "deck surplus, List");
    await pikachu.click();
    const one = page.getByRole("dialog", { name: "Put away 2 copies" });
    await expect(one).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(one).toBeHidden();
    await expect(pikachu).toBeFocused();

    // Put away all: every surplus copy in one Move to the Location the collector picks.
    await surplus.getByRole("button", { name: "Put away all" }).click();
    const dialog = page.getByRole("dialog", { name: "Put away 5 copies" });
    await dialog
      .getByRole("button", { name: built.boxName, exact: true })
      .click();
    await expect(dialog).toContainText("5 copies will move.");
    await expectPageChecks(page, "Put away dialog");
    await dialog.getByRole("button", { name: "Put away 5 copies" }).click();
    await expect(dialog).toBeHidden();
    const toast = page.getByRole("region", { name: "Notifications" });
    await expect(toast).toContainText(`Put away 5 copies to ${built.boxName}.`);
    await expect(toast.getByRole("button", { name: "Undo" })).toBeFocused();
    await expect(surplus).toHaveCount(0);
    await expect(deckList).toContainText("3/60");
    await expectPageChecks(page, "after Put away, with its Undo toast");
    const inBox = async () =>
      Object.fromEntries(
        (await get(page, `/api/holdings/${built.boxId}`)).holdings.map(
          (holding: { edition_id: string; quantity: string }) => [
            holding.edition_id,
            holding.quantity,
          ]
        )
      );
    expect(await inBox()).toEqual({
      [built.editions.charmander]: "3",
      [built.editions.pikachu]: "2",
      [built.editions.ultraBall]: "1",
    });
    const [newest] = (await get(page, "/api/moves/undo")) as {
      source_id: string;
      destination_id: string;
      source_count: number;
    }[];
    expect([
      newest.source_id,
      newest.destination_id,
      newest.source_count,
    ]).toEqual([built.deckId, built.boxId, 1]);

    // Undo returns every copy to the Deck. Copies arriving in a Deck join its Deck List, so they come back listed.
    await toast.getByRole("button", { name: "Undo" }).click();
    await expect(toast).toContainText(
      `Undo returned 5 copies to ${built.deckName}. They're on its Deck List again.`
    );
    await expect(deckList).toContainText("8/60");
    await expect(surplus).toHaveCount(0);
    expect(await inBox()).toEqual({ [built.editions.ultraBall]: "1" });
    await expectWarning(page, built);
  });
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

  test("the Deck tab shows the warning and the surplus, and Put away's Undo outlives a tab switch", async ({
    page,
  }) => {
    promoteCatalog();
    await signIn(page);
    const built = await buildDeck(page);
    await page.goto(`${ORIGIN}/decks/${built.deckId}`);

    const deck = page.getByRole("tab", { name: "Deck 3/60" });
    await deck.tap();
    await expect(page.getByRole("radio", { name: "Stacked" })).toBeChecked();
    await expectWarning(page, built);
    const surplus = page.getByRole("region", {
      name: "Surplus, 5 cards",
      exact: true,
    });
    await expect(
      surplus.getByRole("heading", {
        level: 3,
        name: "Surplus, 5 cards",
        exact: true,
      })
    ).toHaveText("Surplus, 5 cards");
    await expect(
      surplus.getByRole("button", {
        name: surplusPile("Pikachu", "2", "2 copies"),
        exact: true,
      })
    ).toContainText("×2");
    await expectPageChecks(page, "phone deck surplus, Stacked");

    await page.getByRole("radio", { name: "Spread" }).tap();
    await expectPageChecks(page, "phone deck surplus, Spread");
    await page.getByRole("radio", { name: "List" }).tap();
    await expectPageChecks(page, "phone deck surplus, List");
    await page.getByRole("radio", { name: "Stacked" }).tap();

    await surplus.getByRole("button", { name: "Put away all" }).tap();
    const dialog = page.getByRole("dialog", { name: "Put away 5 copies" });
    await dialog
      .getByRole("button", { name: built.boxName, exact: true })
      .tap();
    await expect(dialog).toContainText("5 copies will move.");
    await expectPageChecks(page, "phone Put away dialog");
    await dialog.getByRole("button", { name: "Put away 5 copies" }).tap();
    await expect(dialog).toBeHidden();
    const toast = page.getByRole("region", { name: "Notifications" });
    await expect(toast).toContainText(`Put away 5 copies to ${built.boxName}.`);
    await expectPageChecks(page, "phone after Put away, with its Undo toast");

    // The toast stays with the page, not the tab.
    await page.getByRole("tab", { name: "Library" }).tap();
    await deck.tap();
    await toast.getByRole("button", { name: "Undo" }).tap();
    await expect(toast).toContainText(
      `Undo returned 5 copies to ${built.deckName}.`
    );
    await expect(page.getByRole("tab", { name: "Deck 8/60" })).toBeVisible();
  });
});
