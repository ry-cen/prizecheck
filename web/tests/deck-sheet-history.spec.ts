import { expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { test, artUpstream } from "./support/art-upstream";
import { signInAsOwner } from "./support/sign-in";
import { startAsNewOwner } from "./support/owner";
import { listCards } from "./support/deck-list";

const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";
for (const viewport of [
  { width: 1280, height: 800 },
  { width: 375, height: 812 },
]) {
  test.describe(`${viewport.width}×${viewport.height}`, () => {
    test.use({ viewport, hasTouch: viewport.width === 375 });
    test("Deck sheet traverses history, restores focus, and safely handles direct and invalid links", async ({
      page,
    }) => {
      (await artUpstream()).reset();
      execFileSync(
        ".venv/bin/python",
        ["-c", "from test_catalog_browse import seed_popup\nseed_popup()"],
        {
          env: { ...process.env, PYTHONPATH: "api:api/tests" },
        }
      );
      const pool = new Pool({ connectionString: process.env.DATABASE_URL });
      let deck: string;
      let edition: string;
      try {
        await startAsNewOwner(pool);
        await pool.query("DELETE FROM auth_send_event");
        await signInAsOwner(page, "/decks");
        const response = await page.request.post(`${ORIGIN}/api/decks`, {
          headers: { origin: ORIGIN },
          data: { name: "History Deck", idempotency_key: randomUUID() },
        });
        expect(response.ok()).toBe(true);
        deck = (await response.json()).location.id;
        const { rows } = await pool.query(
          `SELECT e.id FROM catalog_edition e JOIN catalog_printing p ON p.id=e.printing_id WHERE p.source_id='me01-001' AND e.descriptor->>'finish'='normal'`
        );
        edition = rows[0].id;
        const owner = (
          await pool.query("SELECT owner_id FROM location WHERE id=$1", [deck])
        ).rows[0].owner_id;
        await listCards(pool, owner, deck, { [edition]: 2 });
      } finally {
        await pool.end();
      }
      const base = `/decks/${deck}`;
      await page.goto(`${ORIGIN}${base}`);
      const control = page.locator("[data-edition-id]").first();
      await expect(control).toBeVisible();
      await control.click();
      const sheet = page.getByRole("dialog", {
        name: "Bulbasaur",
        exact: true,
      });
      await expect(sheet).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`edition=${edition}`));
      const selected = page.url();
      await page.goBack();
      await expect(page).toHaveURL(`${ORIGIN}${base}`);
      await expect(sheet).toHaveCount(0);
      await expect(control).toBeFocused();
      await page.goForward();
      await expect(sheet).toBeVisible();
      await page.goto(selected);
      await expect(sheet).toBeVisible();
      const length = await page.evaluate(() => history.length);
      await page
        .getByRole("button", { name: "Close card", exact: true })
        .click();
      await expect(page).toHaveURL(`${ORIGIN}${base}`);
      await expect(sheet).toHaveCount(0);
      await expect.poll(() => page.evaluate(() => history.length)).toBe(length);
      for (const query of [
        `edition=${randomUUID()}`,
        `edition=${edition}&copy=0`,
        `edition=${edition}&copy=999`,
        `copy=1`,
      ]) {
        await page.goto(`${ORIGIN}${base}?${query}`);
        await expect(page).toHaveURL(`${ORIGIN}${base}`);
        await expect(sheet).toHaveCount(0);
      }
    });
  });
}
