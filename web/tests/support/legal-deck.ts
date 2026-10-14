import { expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { listCards } from "./deck-list";

// A Deck List that is legal in Standard (#181's "Publish enabled when legal"), built as target-format.spec.ts builds
// its own: the catalog holds the format-check fixtures of api/tests/test_card_attributes.py, imported through the real
// catalog import, so the real rules files judge them on today's date. Bulbasaur, four Rare Candy, four Switch and 51
// Basic Grass Energy are legal in Standard and Expanded until the next rotation; four-ofs break Gym Leader Challenge.

const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";

/** Replaces the catalog with the four format-check fixtures. Clears every Holding. */
export function promoteLegalCatalog() {
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

/** The Normal Edition of a fixture card by its TCGdex id ("me01-001", "me01-125", "me01-130", "sv02-278"). */
export async function legalEdition(sourceId: string): Promise<string> {
  const rows = await query<{ id: string }>(
    `SELECT e.id FROM catalog_edition e JOIN catalog_printing p ON p.id=e.printing_id
     WHERE p.source_id=$1 AND e.descriptor->>'finish'='normal'`,
    [sourceId]
  );
  return rows[0].id;
}

export type LegalDeck = {
  deckId: string;
  deckName: string;
  owner: string;
  editions: {
    bulbasaur: string;
    candy: string;
    switch: string;
    energy: string;
  };
};

/** Creates a Deck through the gateway whose Deck List is the 60 legal cards; it holds none of them. */
export async function buildLegalDeck(
  page: Page,
  prefix = "Bulbasaur"
): Promise<LegalDeck> {
  const deckName = `${prefix} ${randomUUID().slice(0, 6)}`;
  const created = await page.request.post(`${ORIGIN}/api/decks`, {
    headers: { origin: ORIGIN },
    data: { name: deckName, idempotency_key: randomUUID() },
  });
  expect(created.status()).toBe(201);
  const deckId = (await created.json()).location.id as string;
  const [{ owner_id: owner }] = await query<{ owner_id: string }>(
    "SELECT owner_id FROM location WHERE id=$1",
    [deckId]
  );
  const editions = {
    bulbasaur: await legalEdition("me01-001"),
    candy: await legalEdition("me01-125"),
    switch: await legalEdition("me01-130"),
    energy: await legalEdition("sv02-278"),
  };
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await listCards(pool, owner, deckId, {
      [editions.bulbasaur]: 1,
      [editions.candy]: 4,
      [editions.switch]: 4,
      [editions.energy]: 51,
    });
  } finally {
    await pool.end();
  }
  return { deckId, deckName, owner, editions };
}

/** Stores `quantity` copies of `edition` in `locationId` by SQL, with one inventory revision bump. A Deck's Deck List
 * rises to cover copies stored in it (migration 031), never above a line it already has. */
export async function hold(
  owner: string,
  locationId: string,
  edition: string,
  quantity: number
) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query(
      `INSERT INTO holding(owner_id,location_id,edition_id,quantity,version) VALUES($1,$2,$3,$4,1)
       ON CONFLICT (owner_id,location_id,edition_id) DO UPDATE SET quantity=holding.quantity+EXCLUDED.quantity`,
      [owner, locationId, edition, quantity]
    );
    await pool.query(
      "UPDATE inventory_owner SET revision=revision+1 WHERE user_id=$1",
      [owner]
    );
  } finally {
    await pool.end();
  }
}
