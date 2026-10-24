// Conversation helpers for the Trade specs (Trading #298): where a spec reads a Friend's Trades, and the few pieces of
// set-up the API has no route for. A pair's Trades are cards inside their conversation, opened from the Trades list.
import type { Page } from "@playwright/test";
import { Pool } from "pg";
import { expect } from "./collectors";
import { accountId, api } from "./loans";

const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";

/** The Trades tab's conversation list. */
export const conversations = (page: Page) =>
  page.getByRole("list", { name: "Conversations" });

/** An open conversation's messages and Trade cards, oldest first. */
export const timeline = (page: Page) =>
  page.getByRole("list", { name: "Messages and Trades" });

/** The Trade cards of an open conversation (only they are links). */
export const timelineTrades = (page: Page) => timeline(page).getByRole("link");

/** Opens the Trades list, then the conversation with the collector called `name`. */
export async function openConversation(page: Page, name: string) {
  await page.goto(`${ORIGIN}/trades`);
  await conversations(page)
    .getByRole("link", { name: new RegExp("^" + name) })
    .click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(name);
}

/** The page's collector's trader id, read from the database. The UI links to it only through other screens. */
export async function traderIdOf(page: Page): Promise<string> {
  const id = await accountId(page);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const { rows } = await pool.query<{ trader_id: string }>(
      "SELECT trader_id FROM collector_profile WHERE user_id = $1",
      [id]
    );
    return rows[0].trader_id;
  } finally {
    await pool.end();
  }
}

/** Seeds the zip codes the discovery specs use: 00010 (40.0, -100.0), 00011 (0.1 degrees north, about 6.9 mi) and 00012.
 * Upserts, so no spec depends on the generated zip data. Unlike `open-discovery.spec.ts` it leaves 00009 alone. */
export async function seedZips() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query(
      `INSERT INTO zip_centroid (zip, lat, lon, source) VALUES
         ('00010', 40.0, -100.0, 'census'),
         ('00011', 40.1, -100.0, 'census'),
         ('00012', 40.2, -100.0, 'census')
       ON CONFLICT (zip) DO UPDATE SET lat = EXCLUDED.lat, lon = EXCLUDED.lon, source = EXCLUDED.source`
    );
  } finally {
    await pool.end();
  }
}

/** Switches the page's collector into open discovery at `zip` (a seeded one), through the API. */
export const discoverable = (page: Page, zip: string) =>
  api(page, "PUT", "/api/social/discovery", { enabled: true, zip });

/** Counts `count` messages the page's collector sent `minutesAgo` minutes ago against the hourly message limit. */
export async function seedMessages(
  page: Page,
  count: number,
  minutesAgo: number
) {
  const id = await accountId(page);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query(
      `INSERT INTO handle_lookup_event (user_id, kind, created_at)
       SELECT $1, 'message', now() - make_interval(mins => $3::int) FROM generate_series(1, $2::int)`,
      [id, count, minutesAgo]
    );
  } finally {
    await pool.end();
  }
}

/** Makes the page read the pulse now, as a collector returning to the tab does. */
export const focusPulse = (page: Page) =>
  page.evaluate(() => window.dispatchEvent(new Event("focus")));
