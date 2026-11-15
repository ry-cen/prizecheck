import { expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { test, artUpstream } from "./support/art-upstream";
import { signInAsOwner } from "./support/sign-in";
import { startAsNewOwner } from "./support/owner";
import { listCards } from "./support/deck-list";

const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";
async function prepare(page: Page) {
  (await artUpstream()).reset();
  execFileSync(
    ".venv/bin/python",
    ["-c", "from test_catalog_browse import seed_popup\nseed_popup()"],
    {
      env: { ...process.env, PYTHONPATH: "api:api/tests" },
    }
  );
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await startAsNewOwner(pool);
    await pool.query("DELETE FROM auth_send_event");
    await signInAsOwner(page, "/decks");
    const edition = (
      await pool.query(
        `SELECT e.id FROM catalog_edition e JOIN catalog_printing p ON p.id=e.printing_id WHERE p.source_id='me01-001' AND e.descriptor->>'finish'='normal'`
      )
    ).rows[0].id;
    for (let index = 0; index < 10; index++) {
      const response = await page.request.post(`${ORIGIN}/api/decks`, {
        headers: { origin: ORIGIN },
        data: { name: `Scroll Deck ${index}`, idempotency_key: randomUUID() },
      });
      expect(response.ok()).toBe(true);
      const id = (await response.json()).location.id;
      const owner = (
        await pool.query("SELECT owner_id FROM location WHERE id=$1", [id])
      ).rows[0].owner_id;
      await listCards(pool, owner, id, { [edition]: 2 });
    }
  } finally {
    await pool.end();
  }
}
test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });
test("phone Back from a Deck restores the Decks list position", async ({
  page,
}) => {
  await prepare(page);
  await page.goto(`${ORIGIN}/decks`);
  const link = page.getByRole("link", { name: "Scroll Deck 8", exact: true });
  await link.scrollIntoViewIfNeeded();
  // Measure at activation: Playwright may scroll the link again before clicking it.
  // This is the position useRoute records, as in the Want List's existing Back test.
  await page.evaluate(() => {
    document.addEventListener(
      "click",
      () => {
        (
          window as unknown as { deckDepartureScroll: number }
        ).deckDepartureScroll = scrollY;
      },
      { capture: true, once: true }
    );
  });
  await link.click();
  const saved = await page.evaluate(
    () =>
      (window as unknown as { deckDepartureScroll: number }).deckDepartureScroll
  );
  expect(saved).toBeGreaterThan(0);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Scroll Deck 8"
  );
  await page.goBack();
  await expect(link).toBeVisible();
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(saved);
});
test("phone Want List reload restores its position", async ({ page }) => {
  await prepare(page);
  await page.goto(`${ORIGIN}/decks/want-list`);
  const link = page.getByRole("link", {
    name: "Open Deck Scroll Deck 8",
    exact: true,
  });
  await link.scrollIntoViewIfNeeded();
  const saved = await page.evaluate(() => scrollY);
  expect(saved).toBeGreaterThan(0);
  await page.reload();
  await expect(link).toBeVisible();
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(saved);
});
