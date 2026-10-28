// Ticket P4b (#350): the "Prices from TCGCSV" footer credit. The owner's exception to AGENTS.md's no-provenance rule
// (ADR 0019): one line at the end of the signed-in shell and of the public layout, none on the scanner page, no date or
// time, and the only collector-visible mention of TCGCSV. TCGplayer is named elsewhere by the Published Deck page's
// "Buy on TCGplayer" export, which this ticket leaves alone; the text scan below allows exactly that and nothing else.
import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { signInAsOwner } from "./support/sign-in";
import { startAsNewOwner } from "./support/owner";

const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";
const CREDIT = "Prices from TCGCSV";

// A 1×1 PNG stands in for card artwork, so no test reaches the network.
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64"
);

/** Replaces the catalog and publishes a Deck for `owner` (page_world); returns its token. */
function publishedToken(owner: string): string {
  const output = execFileSync(
    ".venv/bin/python",
    [
      "-c",
      `import json, sys
from test_published_deck_page import page_world
print(json.dumps(page_world(sys.argv[1], sys.argv[2])))`,
      owner,
      `Credit ${randomUUID().slice(0, 8)}`,
    ],
    { env: { ...process.env, PYTHONPATH: "api:api/tests" } }
  );
  return (
    JSON.parse(output.toString().trim().split("\n").at(-1)!) as {
      Legal: string;
    }
  ).Legal;
}

async function startSignedIn(page: Page, path: string) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query("DELETE FROM auth_send_event");
    await startAsNewOwner(pool);
  } finally {
    await pool.end();
  }
  await signInAsOwner(page, path);
}

const credit = (page: Page) => page.getByText(CREDIT, { exact: true });

/** Exactly one credit, linking tcgcsv.com, with no date or time in it. */
async function expectOneCredit(page: Page) {
  await expect(credit(page)).toHaveCount(1);
  await expect(credit(page)).toBeVisible();
  await expect(
    credit(page).getByRole("link", { name: "TCGCSV" })
  ).toHaveAttribute("href", "https://tcgcsv.com");
  await expect(credit(page)).not.toContainText(/\d/);
}

/**
 * Every line of page text that names TCGCSV or TCGplayer, other than the credit. TCGCSV appears in no other line.
 * `allowed` lists the TCGplayer lines the page already had (the Published Deck page's Buy on TCGplayer export).
 */
async function otherSourceMentions(page: Page): Promise<string[]> {
  const text = await page.evaluate(() => document.body.innerText);
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) => /TCGCSV|TCGplayer/i.test(line) && line !== "Prices from TCGCSV"
    );
}

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 375, height: 812 },
]) {
  test.describe(`at ${viewport.width}×${viewport.height}`, () => {
    test.use({ viewport });

    test("the Collection, catalog, Published Deck and sign-in pages each end with one credit and name no other source", async ({
      page,
    }) => {
      const token = publishedToken(`credit-owner-${randomUUID()}`);
      await page.route(/^https:\/\/assets\.tcgdex\.net\//, (route) =>
        route.fulfill({ status: 200, contentType: "image/png", body: PIXEL })
      );

      // Signed out: the sign-in page and a Published Deck, in the public layout.
      await page.goto(`${ORIGIN}/sign-in`);
      await expect(
        page.getByRole("navigation", { name: "Public pages" })
      ).toBeVisible();
      await expectOneCredit(page);
      expect(await otherSourceMentions(page)).toEqual([]);

      await page.goto(`${ORIGIN}/published/${token}`);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expectOneCredit(page);
      // It comes after the TCGdex not-endorsed note.
      const note = page.getByText(/Not endorsed by Nintendo/);
      await expect(note).toHaveCount(1);
      const noteBox = (await note.boundingBox())!;
      const creditBox = (await credit(page).boundingBox())!;
      expect(creditBox.y).toBeGreaterThan(noteBox.y + noteBox.height - 1);
      // The page's existing Buy on TCGplayer export is the only other mention, and TCGCSV is in none.
      const published = await otherSourceMentions(page);
      expect(published.length).toBeGreaterThan(0);
      for (const line of published) expect(line).toMatch(/TCGplayer/);
      expect(published.join("\n")).not.toMatch(/TCGCSV/i);

      // Signed in: Collection and the catalog, in the shell.
      await startSignedIn(page, "/collection");
      await expect(
        page.getByRole("navigation", { name: "Main views" })
      ).toBeVisible();
      await expectOneCredit(page);
      expect(await otherSourceMentions(page)).toEqual([]);
      if (viewport.width <= 760) {
        // Scrolled to the end, the credit sits above the fixed tab bar.
        await credit(page).scrollIntoViewIfNeeded();
        const tabs = (await page
          .getByRole("navigation", { name: "Main views" })
          .boundingBox())!;
        const box = (await credit(page).boundingBox())!;
        expect(box.y + box.height).toBeLessThanOrEqual(tabs.y + 0.5);
      }

      await page.goto(`${ORIGIN}/catalog`);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expectOneCredit(page);
      expect(await otherSourceMentions(page)).toEqual([]);
    });

    test("the scanner page shows no credit", async ({ page }) => {
      await startSignedIn(page, "/collection");
      await page.goto(`${ORIGIN}/collection/scan`);
      await expect(page).toHaveURL(/\/collection\/scan$/);
      await expect(
        page.getByRole("button", { name: "Close scanner" })
      ).toBeVisible();
      await expect(credit(page)).toHaveCount(0);
      expect(await otherSourceMentions(page)).toEqual([]);
    });
  });
}
