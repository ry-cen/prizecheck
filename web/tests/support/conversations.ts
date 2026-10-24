// Conversation helpers for the Trade specs (Trading #298): where a spec reads a Friend's Trades, and the few pieces of
// set-up the API has no route for. A pair's Trades are cards inside their conversation, opened from the Trades list.
import type { Page } from "@playwright/test";
import { Pool } from "pg";
import { expect } from "./collectors";
import { accountId } from "./loans";

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
