import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { expectPageChecks } from "./support/page-check";
import { listCards } from "./support/deck-list";
import { startAsNewOwner } from "./support/owner";

// Gather (#179): Gather N in the deck header opens the Pick List as a dialog arranged by card, with a source picker per
// row and a warning when a source is another Deck that would be left short. Confirm picked and Confirm all are each one
// multi-source Move with one Undo record, so one Undo puts back copies from more than five Locations.

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
promote({'card-1': 'Charmander', 'card-2': 'Ultra Ball', 'card-3': 'Pikachu'})`,
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
  otherName: string;
  /** Box 1 … Box 6, in order. */
  boxes: { id: string; name: string }[];
  editions: { charmander: string; ultraBall: string; pikachu: string };
};

/**
 * A Deck whose 9-card Deck List is all owned elsewhere: Charmander 6 (one copy in each of six Boxes), Pikachu 2 (both
 * in Box 1) and Ultra Ball 1 (held by another Deck for its own Deck List line, so taking it leaves that Deck short).
 * Gather N reads 9, from 7 Locations.
 */
async function buildDeck(page: Page): Promise<Built> {
  const suffix = randomUUID().slice(0, 6);
  const deckName = `Gather ${suffix}`;
  const otherName = `Other ${suffix}`;
  const deck = async (name: string) =>
    (await post(page, "/api/decks", { name, idempotency_key: randomUUID() }))
      .location.id as string;
  const deckId = await deck(deckName);
  const otherId = await deck(otherName);
  const boxes: Built["boxes"] = [];
  for (let number = 1; number <= 6; number++) {
    const name = `Box ${number} ${suffix}`;
    const created = await post(page, "/api/location-tree", {
      name,
      parent_id: null,
      parent_version: null,
      idempotency_key: randomUUID(),
    });
    boxes.push({ id: created.location.id as string, name });
  }
  const editions = {
    charmander: await editionOf("card-1"),
    ultraBall: await editionOf("card-2"),
    pikachu: await editionOf("card-3"),
  };
  const hold = (location: string, edition: string, quantity: number) =>
    post(page, "/api/holdings", {
      location_id: location,
      edition_id: edition,
      quantity: String(quantity),
      idempotency_key: randomUUID(),
    });
  for (const box of boxes) await hold(box.id, editions.charmander, 1);
  await hold(boxes[0].id, editions.pikachu, 2);
  // A copy arriving in a Deck extends its Deck List (migration 031), so the other Deck lists its Ultra Ball.
  await hold(otherId, editions.ultraBall, 1);
  const [{ owner_id: owner }] = await query<{ owner_id: string }>(
    "SELECT owner_id FROM location WHERE id=$1",
    [deckId]
  );
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await listCards(pool, owner, deckId, {
      [editions.charmander]: 6,
      [editions.pikachu]: 2,
      [editions.ultraBall]: 1,
    });
  } finally {
    await pool.end();
  }
  return { deckId, deckName, otherName, boxes, editions };
}

type UndoEntry = {
  id: string;
  source_id: string | null;
  destination_id: string | null;
  source_count: number;
};

const edition = (number: string) => `Fixture Set · ${number} · Normal`;

test.describe("on a desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("Gather N confirms the picked rows, then every row from more than five Locations, each with one Undo", async ({
    page,
  }) => {
    promoteCatalog();
    await signIn(page);
    const built = await buildDeck(page);
    await page.goto(`${ORIGIN}/decks/${built.deckId}`);

    const gatherNine = page.getByRole("button", { name: "Gather 9" });
    await gatherNine.click();
    const dialog = page.getByRole("dialog", { name: "Gather cards you own" });
    await expect(dialog).toContainText("9 copies from 7 Locations.");
    const rows = dialog.getByRole("list", { name: "Cards to gather" });
    await expect(rows.getByRole("listitem")).toHaveCount(3);

    // Charmander comes from six Boxes; the picker starts on the suggestion and offers each Box on its own.
    const charmander = rows
      .getByRole("listitem")
      .filter({ hasText: "Charmander" });
    const source = charmander.getByLabel("Source for Charmander");
    await expect(source.locator("option:checked")).toHaveText(
      "Suggested: 6 Locations"
    );
    await expect(source.locator("option")).toHaveCount(7);
    await expect(charmander).toContainText(
      `6 copies: 1 from ${built.boxes[0].name}`
    );
    // Ultra Ball's only copy is another Deck's own.
    await expect(
      rows.getByRole("listitem").filter({ hasText: "Ultra Ball" })
    ).toContainText(`Leaves ${built.otherName} (Deck) 1 short`);
    await expect(
      dialog.getByRole("button", { name: "Confirm picked" })
    ).toBeDisabled();
    await expectPageChecks(page, "Gather dialog");

    // Confirm picked: only Pikachu moves, with one Undo.
    await dialog
      .getByRole("checkbox", { name: `Pick Pikachu, ${edition("3")}` })
      .check();
    await dialog.getByRole("button", { name: "Confirm 1 picked" }).click();
    await expect(dialog).toBeHidden();
    const toast = page.getByRole("region", { name: "Notifications" });
    await expect(toast).toContainText(
      `Moved 2 copies from 1 Location into ${built.deckName}.`
    );
    await expect(toast.getByRole("button", { name: "Undo" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Gather 7" })).toBeVisible();

    // Confirm all: seven Locations in one Move.
    await page.getByRole("button", { name: "Gather 7" }).click();
    await expect(dialog).toContainText("7 copies from 7 Locations.");
    await dialog.getByRole("button", { name: "Confirm all" }).click();
    await expect(dialog).toBeHidden();
    await expect(toast).toContainText(
      `Moved 7 copies from 7 Locations into ${built.deckName}.`
    );
    await expect(page.getByRole("button", { name: "Gather 0" })).toBeDisabled();
    await expectPageChecks(page, "after Gather, with its Undo toast");
    // One Undo record per confirmation: Confirm all is the newest, naming all seven sources.
    const entries = (await get(page, "/api/moves/undo")) as UndoEntry[];
    expect(
      entries.map((entry) => [
        entry.source_id,
        entry.destination_id,
        entry.source_count,
      ])
    ).toEqual([
      [null, built.deckId, 7],
      [built.boxes[0].id, built.deckId, 1],
    ]);

    // One Undo puts every copy back in all seven Locations; the earlier Gather's record stays.
    await toast.getByRole("button", { name: "Undo" }).click();
    await expect(toast).toContainText("Undo put 7 copies back in 7 Locations.");
    await expect(page.getByRole("button", { name: "Gather 7" })).toBeVisible();
    for (const box of built.boxes)
      expect(
        (await get(page, `/api/holdings/${box.id}`)).holdings.map(
          (holding: { edition_id: string; quantity: string }) => [
            holding.edition_id,
            holding.quantity,
          ]
        )
      ).toEqual([[built.editions.charmander, "1"]]);
    expect(
      ((await get(page, "/api/moves/undo")) as UndoEntry[]).map(
        (entry) => entry.id
      )
    ).toEqual([entries[1].id]);
  });

  test("the copy sheet's Gather opens the Pick List on that card, and a chosen Location is the one used", async ({
    page,
  }) => {
    promoteCatalog();
    await signIn(page);
    const built = await buildDeck(page);
    await page.goto(`${ORIGIN}/decks/${built.deckId}`);

    const copy = page.getByRole("button", {
      name: `Pikachu, ${edition("3")}, copy 1 of 2: owned elsewhere, in ${built.boxes[0].name}`,
      exact: true,
    });
    const sheet = page.getByRole("dialog", { name: "Pikachu" });
    const dialog = page.getByRole("dialog", { name: "Gather cards you own" });

    // Closing the Pick List returns focus to the copy that opened it.
    await copy.click();
    await sheet.getByRole("button", { name: "Gather", exact: true }).click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(copy).toBeFocused();

    await copy.click();
    await sheet.getByRole("button", { name: "Gather", exact: true }).click();
    await expect(sheet).toBeHidden();
    const pikachu = dialog.getByRole("checkbox", {
      name: `Pick Pikachu, ${edition("3")}`,
    });
    await expect(pikachu).toBeChecked();
    await expect(pikachu).toBeFocused();
    await expect(
      dialog.getByRole("button", { name: "Confirm 1 picked" })
    ).toBeVisible();

    // Charmander from Box 3 only: one copy, from there.
    const charmander = dialog
      .getByRole("listitem")
      .filter({ hasText: "Charmander" });
    await charmander
      .getByLabel("Source for Charmander")
      .selectOption({ label: `${built.boxes[2].name}: 1 here` });
    await expect(charmander).toContainText(
      `1 copy: 1 from ${built.boxes[2].name}`
    );
    await dialog
      .getByRole("checkbox", { name: `Pick Charmander, ${edition("1")}` })
      .check();
    await dialog.getByRole("button", { name: "Confirm 2 picked" }).click();
    await expect(dialog).toBeHidden();
    const toast = page.getByRole("region", { name: "Notifications" });
    await expect(toast).toContainText(
      `Moved 3 copies from 2 Locations into ${built.deckName}.`
    );
    await expect(toast.getByRole("button", { name: "Undo" })).toBeFocused();
    expect(
      (await get(page, `/api/holdings/${built.boxes[2].id}`)).holdings
    ).toEqual([]);
    expect(
      (await get(page, `/api/holdings/${built.boxes[1].id}`)).holdings
    ).toHaveLength(1);

    // Escape closes the Pick List and returns focus to Gather N.
    const gather = page.getByRole("button", { name: "Gather 6" });
    await gather.click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(gather).toBeFocused();
  });
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

  test("the Pick List fills the screen, and Confirm all and its Undo work by touch", async ({
    page,
  }) => {
    promoteCatalog();
    await signIn(page);
    const built = await buildDeck(page);
    await page.goto(`${ORIGIN}/decks/${built.deckId}`);

    await page.getByRole("tab", { name: "Deck 9/60" }).tap();
    await page.getByRole("button", { name: "Gather 9" }).tap();
    const dialog = page.getByRole("dialog", { name: "Gather cards you own" });
    await expect(dialog.getByRole("listitem")).toHaveCount(3);
    await expectPageChecks(page, "phone Gather dialog");

    await dialog.getByRole("button", { name: "Confirm all" }).tap();
    await expect(dialog).toBeHidden();
    const toast = page.getByRole("region", { name: "Notifications" });
    await expect(toast).toContainText(
      `Moved 9 copies from 7 Locations into ${built.deckName}.`
    );
    await expectPageChecks(page, "phone, after Gather, with its Undo toast");
    await toast.getByRole("button", { name: "Undo" }).tap();
    await expect(toast).toContainText("Undo put 9 copies back in 7 Locations.");
    await expect(page.getByRole("button", { name: "Gather 9" })).toBeVisible();
  });
});
