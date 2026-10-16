import {
  expect,
  test as base,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
} from "@playwright/test";
import { Pool } from "pg";
import { signInAsOwner } from "./sign-in";

// Journeys between collectors (social network, #247 onward) need several signed-in accounts on one stack. The stacks
// run owner-only sign-up: only the owner email can make an account, and only while no existing account holds the owner
// seat. So another collector is made by signing in as the owner in a new browser context and then retiring that
// account from the seat: its email changes to one nobody signs in with, its provider links and any owner binding go.
// Its session stays valid (the gateway checks the gate only when signing in), so it stays signed in as a separate
// collector, and the next owner sign-in makes a new account.
const OWNER_EMAIL = process.env.OWNER_EMAIL || "owner@example.test";
const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";

export type OtherCollector = {
  /** The collector's own browser context; the `collectors` fixture closes it after the test. */
  context: BrowserContext;
  page: Page;
  /** The account id, which the API calls the owner id. */
  userId: string;
};

export type OtherCollectorOptions = {
  /** Where the sign-in lands (default /collection). */
  next?: string;
  /** Options for the new context, for example a phone viewport. */
  contextOptions?: BrowserContextOptions;
};

/** Takes every account holding the owner email out of the owner seat. Their sessions keep working. */
export async function retireOwnerSeat(pool: Pool): Promise<void> {
  // Only against a verification stack's disposable database: by hand it would take the developer's own account out
  // of the owner seat.
  if (!process.env.VERIFY_BROWSER_STACKS)
    throw new Error(
      "retireOwnerSeat retires the owner's account; run specs through npm run verify"
    );
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM "user" WHERE email=$1',
    [OWNER_EMAIL]
  );
  for (const { id } of rows) {
    await pool.query('DELETE FROM account WHERE "userId"=$1', [id]);
    await pool.query("DELETE FROM owner_binding WHERE user_id=$1", [id]);
    await pool.query(
      `UPDATE "user" SET email='collector-'||id||'@retired.example.test' WHERE id=$1`,
      [id]
    );
  }
}

/**
 * Signs in a new collector in its own browser context and returns it. Afterwards the owner seat is free again, so the
 * test's own page can sign in as the owner (it becomes yet another collector), or call this again for a third one.
 * A page already signed in as the owner when this is called stays signed in, but its account leaves the seat: sign it
 * in after the other collectors when it must be the owner.
 */
export async function signInOtherCollector(
  browser: Browser,
  pool: Pool,
  { next = "/collection", contextOptions = {} }: OtherCollectorOptions = {}
): Promise<OtherCollector> {
  // Only against a verification stack's disposable database: by hand it would take the developer's own account out
  // of the owner seat.
  if (!process.env.VERIFY_BROWSER_STACKS)
    throw new Error(
      "signInOtherCollector retires the owner's account; run specs through npm run verify"
    );
  await retireOwnerSeat(pool);
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  await signInAsOwner(page, next);
  const session = await page.request.get(new URL("/auth/session", ORIGIN).href);
  const { userId } = (await session.json()) as { userId?: string };
  expect(userId, "the new collector's session names its account").toBeTruthy();
  await retireOwnerSeat(pool);
  return { context, page, userId: userId! };
}

/**
 * A test with `collectors` can sign in other collectors with `collectors.signIn(options)`. Their contexts close, and
 * the database pool ends, when the test ends.
 */
export const test = base.extend<{
  collectors: {
    signIn: (options?: OtherCollectorOptions) => Promise<OtherCollector>;
    pool: Pool;
  };
}>({
  collectors: async ({ browser }, use) => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const opened: OtherCollector[] = [];
    try {
      await use({
        pool,
        signIn: async (options) => {
          const collector = await signInOtherCollector(browser, pool, options);
          opened.push(collector);
          return collector;
        },
      });
    } finally {
      for (const collector of opened) await collector.context.close();
      await pool.end();
    }
  },
});

export { expect };
