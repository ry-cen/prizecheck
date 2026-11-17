import { test, expect, type Page } from "@playwright/test";
import { signInAsOwner } from "./support/sign-in";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { listHoldings } from "./support/deck-list";
import { exemptNamedDeck, showAsLegal } from "./support/publish-gate";

// A Deck's section headings and copy-sheet buttons have clear accessible names, and the Publish dialog can copy the
// public link once the Deck is published (Copy link, with the Published Deck page's fallback when the clipboard refuses).

const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";

const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "phone", width: 375, height: 812 },
];

/** A signed-in owner's new Deck of three Pikachu on its Deck List, shown to the page as legal so it can publish. */
async function deckOfPikachu(page: Page) {
  execFileSync(
    ".venv/bin/python",
    [
      "-c",
      "from test_catalog_search import promote\npromote({'card-1':'Pikachu'})",
    ],
    { env: { ...process.env, PYTHONPATH: "api:api/tests" } }
  );
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query("DELETE FROM auth_send_event");
    await signInAsOwner(page, "/collection");
    await page.getByRole("link", { name: "Decks", exact: true }).click();
    const name = `Names ${randomUUID().slice(0, 8)}`;
    await page.getByLabel("Deck name").fill(name);
    await page
      .getByRole("button", { name: "Create Deck", exact: true })
      .click();
    await expect(page).toHaveURL(/\/decks\/[^/?#]+$/);
    const deckId = page.url().split("/").at(-1)!;
    const edition = (
      await pool.query(
        `SELECT e.id FROM catalog_edition e JOIN catalog_printing p ON p.id=e.printing_id
         WHERE p.source_id='card-1' ORDER BY e.descriptor->>'finish'='normal' DESC LIMIT 1`
      )
    ).rows[0].id as string;
    const added = await page.request.post(`${ORIGIN}/api/holdings`, {
      headers: { origin: ORIGIN },
      data: {
        location_id: deckId,
        edition_id: edition,
        quantity: "3",
        idempotency_key: randomUUID(),
      },
    });
    expect(added.status()).toBe(200);
    await listHoldings(pool, name, 3);
    await exemptNamedDeck(pool, name);
    await showAsLegal(page, deckId);
    await page.goto(`${ORIGIN}/decks/${deckId}`);
    return { deckId };
  } finally {
    await pool.end();
  }
}

for (const viewport of VIEWPORTS) {
  test.describe(viewport.name, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("a section heading reads as one phrase and the copy sheet's buttons name the card", async ({
      page,
    }) => {
      await deckOfPikachu(page);

      // "Pokémon, 3 cards": no stray space before the comma.
      const heading = page.getByRole("heading", { name: "Pokémon, 3 cards" });
      await expect(heading).toBeVisible();
      await expect(heading).toContainText("Pokémon");

      // The section is a region named by its heading, on desktop and on a phone alike.
      await page
        .getByRole("region", { name: "Pokémon, 3 cards" })
        .getByRole("button", { name: /^Pikachu, / })
        .first()
        .click();
      const sheet = page.getByRole("dialog", { name: "Pikachu" });
      const stepper = sheet.getByRole("group", { name: "Deck List copies" });
      const remove = stepper.getByRole("button", {
        name: "−1, Remove one Pikachu",
        exact: true,
      });
      const add = stepper.getByRole("button", {
        name: "+1, Add one Pikachu",
        exact: true,
      });
      await expect(remove).toHaveText("−1");
      await expect(add).toHaveText("+1");
      await expect(stepper.getByRole("button")).toHaveCount(2);
      await add.click();
      await expect(stepper).toContainText("4 on Deck List");
      await remove.click();
      await expect(stepper).toContainText("3 on Deck List");
      // The Deck is read again after each edit through showAsLegal's route: let that read finish before the test ends.
      await page.unrouteAll({ behavior: "wait" });
    });

    test("after publishing, Copy link copies the public link, falls back when the clipboard refuses, and goes with the link when revoked", async ({
      page,
      context,
    }) => {
      await deckOfPikachu(page);
      await context.grantPermissions(["clipboard-read", "clipboard-write"], {
        origin: ORIGIN,
      });

      await page.getByRole("button", { name: "Publish", exact: true }).click();
      const dialog = page.getByRole("dialog", {
        name: /^(Publish|Published Deck)$/,
      });
      await expect(
        dialog.getByRole("button", { name: "Copy link" })
      ).toHaveCount(0);
      await dialog.getByLabel("Public title").fill("Copy my link");
      await dialog
        .getByRole("button", { name: "Publish Unlisted snapshot", exact: true })
        .click();
      const view = dialog.getByRole("link", { name: "View public snapshot" });
      await expect(view).toBeVisible();
      const url = `${ORIGIN}${await view.getAttribute("href")}`;
      expect(url).toMatch(/\/published\/[A-Za-z0-9_-]{32}$/);

      // The status line is a polite live region, and the confirmation says nothing about where the link comes from.
      const copy = dialog.getByRole("button", { name: "Copy link" });
      await expect(copy).toBeVisible();
      await copy.click();
      const status = dialog.getByRole("status").last();
      await expect(status).toHaveText("Link copied.");
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
        url
      );

      // Where the clipboard refuses, the link is shown to copy by hand.
      await page.evaluate(() => {
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: { writeText: () => Promise.reject(new Error("denied")) },
        });
      });
      await copy.click();
      await expect(status).toHaveText(`Copy this link: ${url}`);

      // Revoking takes the link away, and Copy link with it.
      await dialog
        .getByRole("button", { name: "Revoke: Copy my link" })
        .click();
      await dialog.getByRole("button", { name: "Revoke for good" }).click();
      await expect(dialog.getByRole("status").last()).toHaveText(
        "Public link revoked permanently."
      );
      await expect(
        dialog.getByRole("button", { name: "Copy link" })
      ).toHaveCount(0);
      await expect(
        dialog.getByRole("link", { name: "View public snapshot" })
      ).toHaveCount(0);
      await page.unrouteAll({ behavior: "wait" });
    });
  });
}
