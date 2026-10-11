import { expect } from "@playwright/test";
import type { Pool } from "pg";

// Deck List fixture state for browser specs. A Published Deck freezes a Deck's Deck List, never its Holdings
// (Deck Lists 09), and the web UI does not edit Deck Lists yet, so specs write lines straight to PostgreSQL like their
// other fixture state. Each write advances the Deck List revision.

async function advance(pool: Pool, owner: string, deckId: string) {
  const updated = await pool.query(
    "UPDATE deck_list SET revision=revision+1 WHERE owner_id=$1 AND deck_id=$2",
    [owner, deckId]
  );
  expect(updated.rowCount).toBe(1);
}

/**
 * Once the named Deck holds `copies` cards, give it one Deck List line per held Edition at the held quantity. When
 * Holdings added to a Deck already extend its Deck List (ticket 05), the lines already match and nothing changes.
 */
export async function listHoldings(
  pool: Pool,
  deckName: string,
  copies: number
) {
  const held = async () =>
    Number(
      (
        await pool.query(
          `SELECT coalesce(sum(h.quantity),0) AS n FROM holding h
           JOIN location l ON l.owner_id=h.owner_id AND l.id=h.location_id
           WHERE l.kind='deck' AND l.name=$1`,
          [deckName]
        )
      ).rows[0].n
    );
  await expect.poll(held).toBe(copies);
  const decks = await pool.query(
    "SELECT owner_id,id FROM location WHERE kind='deck' AND name=$1",
    [deckName]
  );
  expect(decks.rowCount).toBe(1);
  const { owner_id: owner, id } = decks.rows[0];
  await pool.query(
    `INSERT INTO deck_list_line(owner_id,deck_id,edition_id,quantity)
     SELECT owner_id,location_id,edition_id,quantity FROM holding WHERE owner_id=$1 AND location_id=$2
     ON CONFLICT (owner_id,deck_id,edition_id) DO UPDATE SET quantity=EXCLUDED.quantity`,
    [owner, id]
  );
  await advance(pool, owner, id);
}

/** Give a Deck Deck List lines `{edition id: quantity}` for cards it does not hold. */
export async function listCards(
  pool: Pool,
  owner: string,
  deckId: string,
  quantities: Record<string, number>
) {
  for (const [edition, quantity] of Object.entries(quantities))
    await pool.query(
      `INSERT INTO deck_list_line(owner_id,deck_id,edition_id,quantity) VALUES($1,$2,$3,$4)
       ON CONFLICT (owner_id,deck_id,edition_id) DO UPDATE SET quantity=EXCLUDED.quantity`,
      [owner, deckId, edition, quantity]
    );
  await advance(pool, owner, deckId);
}

/** A private Deck List edit: raise one line by `extra` copies. */
export async function raiseLine(
  pool: Pool,
  deckId: string,
  edition: string,
  extra: number
) {
  const raised = await pool.query(
    "UPDATE deck_list_line SET quantity=quantity+$3 WHERE deck_id=$1 AND edition_id=$2 RETURNING owner_id",
    [deckId, edition, extra]
  );
  expect(raised.rowCount).toBe(1);
  await advance(pool, raised.rows[0].owner_id, deckId);
}
