import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { signInAsOwner } from "./support/sign-in";
import { createDeck, ORIGIN } from "./support/loans";
import { listHoldings } from "./support/deck-list";
import { exemptNamedDeck } from "./support/publish-gate";

test("Published Deck skip link and landmarks signed out and signed in at both sizes", async ({
  page,
  browser,
}) => {
  execFileSync(
    ".venv/bin/python",
    [
      "-c",
      "from test_catalog_search import promote\npromote({'card-1': 'Pikachu'})",
    ],
    { env: { ...process.env, PYTHONPATH: "api:api/tests" } }
  );
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const anonymous = await browser.newContext();
  try {
    await pool.query("DELETE FROM auth_send_event");
    await signInAsOwner(page, "/collection");
    const name = `Skip target ${randomUUID()}`;
    const deck = await createDeck(page, name);
    const {
      rows: [edition],
    } = await pool.query(
      "SELECT e.id FROM catalog_edition e JOIN catalog_printing p ON p.id=e.printing_id WHERE p.source_id='card-1' LIMIT 1"
    );
    const added = await page.request.post(`${ORIGIN}/api/holdings`, {
      headers: { origin: ORIGIN },
      data: {
        location_id: deck,
        edition_id: edition.id,
        quantity: "1",
        idempotency_key: randomUUID(),
      },
    });
    expect(added.ok()).toBe(true);
    await listHoldings(pool, name, 1);
    // Match publications.spec.ts: the fixture tests public navigation, not format legality.
    await exemptNamedDeck(pool, name);
    const published = await page.request.post(
      `${ORIGIN}/api/decks/${deck}/publication`,
      {
        headers: { origin: ORIGIN },
        data: { title: "Skip destination", idempotency_key: randomUUID() },
      }
    );
    expect(published.ok()).toBe(true);
    const { token } = await published.json();
    const publicPage = await anonymous.newPage();
    for (const reader of [publicPage, page]) {
      for (const viewport of [
        { width: 1280, height: 800 },
        { width: 375, height: 812 },
      ]) {
        await reader.setViewportSize(viewport);
        await reader.goto(`${ORIGIN}/published/${token}`);
        const heading = reader.getByRole("heading", {
          name: "Skip destination",
          exact: true,
        });
        await expect(heading).toBeVisible();
        await expect(reader.locator("#main-content")).toContainText(
          "Skip destination"
        );
        await reader
          .getByRole("link", { name: "Skip to main content" })
          .focus();
        await reader.keyboard.press("Enter");
        await expect(heading).toBeFocused();
        expect(
          (
            await new AxeBuilder({ page: reader })
              .withRules(["skip-link", "region"])
              .analyze()
          ).violations
        ).toEqual([]);
      }
    }
  } finally {
    await anonymous.close();
    await pool.end();
  }
});
