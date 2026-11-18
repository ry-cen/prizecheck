import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { Pool } from "pg";
import { listCards } from "./support/deck-list";
import {
  heard,
  settle,
  since,
  snapshot,
  watch,
} from "./support/live-announcements";
import { startAsNewOwner } from "./support/owner";
import { signInAsOwner } from "./support/sign-in";

// The Deck's format summary ("Standard: Not legal", the status line in the Target Format control) and the
// announcement of a Deck List edit (desktop). The summary says the Format and the Deck's standing, and speaks only when
// the Format or the standing changes: a deliberate Target Format change says its result once, an edit that tips the Deck
// between legal and not legal says so once beside the edit's own message, and every other edit, including one that
// only changes the issue count, says just its own message. The cards are target-format.spec.ts's: 60 cards, legal in
// Standard until one copy goes.

const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";
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

const editionOf = async (sourceId: string) =>
  (
    await query<{ id: string }>(
      `SELECT e.id FROM catalog_edition e JOIN catalog_printing p ON p.id=e.printing_id
       WHERE p.source_id=$1 AND e.descriptor->>'finish'='normal'`,
      [sourceId]
    )
  )[0].id;

/** A 60-card Deck List that holds none of its cards: legal in Standard, not in Gym Leader Challenge. */
async function buildDeck(page: Page): Promise<string> {
  const created = await page.request.post(`${ORIGIN}/api/decks`, {
    headers: { origin: ORIGIN },
    data: {
      name: `Format ${randomUUID().slice(0, 6)}`,
      idempotency_key: randomUUID(),
    },
  });
  expect(created.status()).toBe(201);
  const deckId = (await created.json()).location.id as string;
  const [{ owner_id: owner }] = await query<{ owner_id: string }>(
    "SELECT owner_id FROM location WHERE id=$1",
    [deckId]
  );
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await listCards(pool, owner, deckId, {
      [await editionOf("me01-001")]: 1,
      [await editionOf("me01-125")]: 4,
      [await editionOf("me01-130")]: 4,
      [await editionOf("sv02-278")]: 51,
    });
  } finally {
    await pool.end();
  }
  return deckId;
}

test.use({ viewport: { width: 1280, height: 800 } });

async function open(page: Page) {
  promoteCatalog();
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query("DELETE FROM auth_send_event");
    await startAsNewOwner(pool);
  } finally {
    await pool.end();
  }
  await signInAsOwner(page, "/collection");
  await page.route(/^https:\/\/assets\.tcgdex\.net\//, (route) =>
    route.abort()
  );
  const deck = await buildDeck(page);
  await page.goto(`${ORIGIN}/decks/${deck}`);
  const control = page.getByRole("group", {
    name: "Target Format and result",
  });
  await expect(control.getByRole("button", { name: /result$/ })).toHaveText(
    /Legal/
  );
  return control;
}

const edit = async (page: Page, button: "Add one" | "Remove one") => {
  await page
    .getByRole("button", { name: /^Rare Candy, / })
    .first()
    .hover();
  await page
    .getByRole("button", { name: `${button} Rare Candy`, exact: true })
    .first()
    .click();
};

test("an edit says its own message, and the format summary only when the Deck's standing changes", async ({
  page,
}) => {
  const control = await open(page);
  await watch(page);
  const result = control.getByRole("button", { name: /result$/ });
  const toast = page.getByRole("region", { name: "Notifications" });

  // [button, the edit's words, the summary's words when it speaks, the result button afterwards]
  for (const [button, saying, summary, after] of [
    [
      "Remove one",
      "Removed 1 Rare Candy.",
      /^Standard: Not legal$/,
      /Not legal/,
    ],
    ["Remove one", "Removed 1 Rare Candy.", null, /Not legal/],
    ["Add one", "Added 1 Rare Candy.", null, /Not legal/],
    ["Add one", "Added 1 Rare Candy.", /^Standard: Legal$/, /Legal/],
  ] as const) {
    const mark = (await heard(page)).length;
    await edit(page, button);
    await expect(toast).toContainText(saying);
    await expect(result).toHaveText(after);
    await settle(page);
    const said = await since(page, mark);
    expect(said.filter((text) => text.startsWith(saying))).toHaveLength(1);
    expect(said.filter((text) => /^Standard: /.test(text))).toHaveLength(
      summary ? 1 : 0
    );
    if (summary)
      expect(said.find((text) => /^Standard: /.test(text))).toMatch(summary);
    // Nothing else is spoken: every addition to a live region is one of these.
    expect(said).toHaveLength(summary ? 2 : 1);
    // The status line carries the Format and standing only, never blank and never a count that could go out of date; the
    // result button's name is where the current count is.
    await expect(control.getByRole("status")).toHaveText(
      /Legal/.test(String(after)) && !/Not legal/.test(String(after))
        ? "Standard: Legal"
        : "Standard: Not legal"
    );
    await expect(control.getByRole("status")).not.toHaveText(/\d/);
    expect(
      (await snapshot(page)).filter((text) => /^Standard: /.test(text)).length
    ).toBe(1);
  }
});

test("a deliberate Target Format change says its result once", async ({
  page,
}) => {
  const control = await open(page);
  await watch(page);
  const mark = (await heard(page)).length;
  await control.getByRole("button", { name: /^Target Format: / }).click();
  await page
    .getByRole("menu", { name: /^Target Format: / })
    .getByRole("menuitemradio", { name: "Gym Leader Challenge", exact: true })
    .click();
  await expect(
    control.getByRole("button", {
      name: /^Target Format: Gym Leader Challenge/,
    })
  ).toBeVisible();
  await expect(control.getByRole("button", { name: /result$/ })).toHaveText(
    /Not legal/
  );
  await settle(page);
  const said = await since(page, mark);
  expect(said).toEqual([
    expect.stringMatching(/^Gym Leader Challenge: Not legal$/),
  ]);
});
