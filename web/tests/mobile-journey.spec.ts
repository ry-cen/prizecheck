import { test, expect } from "@playwright/test";
import { signInAsOwner } from "./support/sign-in";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { listHoldings } from "./support/deck-list";
import { exemptNamedDeck, showAsLegal } from "./support/publish-gate";

test.use({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});
test("mobile collector can search, Add, Move, Undo, check and publish a physical Deck", async ({
  page,
  browser,
}) => {
  // A long journey with a catalog import: usually 5-26 s, over 30 s on a loaded host.
  test.slow();
  execFileSync(
    ".venv/bin/python",
    [
      "-c",
      "from test_catalog_search import promote\npromote({'card-1':'Pikachu'})",
    ],
    { env: { ...process.env, PYTHONPATH: "api:api/tests" } }
  );
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const anonymous = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const publicPage = await anonymous.newPage();
  try {
    await pool.query("DELETE FROM auth_send_event");
    await signInAsOwner(page, "/collection");
    await page
      .getByRole("navigation", { name: "Main views" })
      .getByRole("button", { name: "Decks", exact: true })
      .tap();
    const name = "Mobile private " + randomUUID().slice(0, 8);
    await page.getByLabel("Deck name").fill(name);
    await page.getByRole("button", { name: "Create Deck", exact: true }).tap();
    // The deck builder plans the Deck List; its Holdings, with Move and Undo, live in Collection under the Deck's
    // banner (#181). Cards reach the Deck through the gateway, as Collection's Add cards does.
    await expect(page).toHaveURL(/\/decks\/[^/?#]+$/);
    const deckId = page.url().split("/").at(-1)!;
    const origin = process.env.TEST_ORIGIN || "http://localhost:5173";
    const pikachu = (
      await pool.query(
        `SELECT e.id FROM catalog_edition e JOIN catalog_printing p ON p.id=e.printing_id
         WHERE p.source_id='card-1' AND e.descriptor->>'finish'='normal'`
      )
    ).rows[0].id as string;
    async function add(quantity: string) {
      const added = await page.request.post(`${origin}/api/holdings`, {
        headers: { origin },
        data: {
          location_id: deckId,
          edition_id: pikachu,
          quantity,
          idempotency_key: randomUUID(),
        },
      });
      expect(added.status()).toBe(200);
    }
    await add("3");
    await page.goto(`${origin}/collection?location=${deckId}`);
    await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
    await expect(page.getByRole("main")).toContainText("3 copies · 1 edition");
    const tiles = page
      .getByRole("region", { name: "Cards" })
      .getByRole("button");
    const strip = page.getByRole("region", { name: "Selection" });
    await page.getByRole("button", { name: "Select", exact: true }).tap();
    await tiles.nth(0).tap();
    await tiles.nth(1).tap();
    await expect(strip).toContainText("2 copies selected");
    await strip.getByRole("button", { name: "Actions" }).tap();
    await strip.getByRole("button", { name: "Move…" }).tap();
    const move = page.getByRole("dialog", { name: "Move 2 copies" });
    // Destinations are labelled by full path, so exact "Unsorted" is the top-level leaf, never "Box / Unsorted".
    await move.getByRole("button", { name: "Unsorted", exact: true }).tap();
    await move.getByRole("button", { name: "Move 2 copies" }).tap();
    await expect(page.getByRole("main")).toContainText("1 copy · 1 edition");
    await page.getByRole("button", { name: "Undo", exact: true }).tap();
    await expect(page.getByRole("main")).toContainText("3 copies · 1 edition");
    // Publishing freezes the Deck List; list the cards the Deck holds.
    await listHoldings(pool, name, 3);
    await exemptNamedDeck(pool, name); // not a legal Deck List in any Format
    // Publish waits for a legal result; the exempt Deck is shown to the page as legal (support/publish-gate.ts).
    await showAsLegal(page, deckId);
    await page
      .getByRole("region", { name: "Deck banner" })
      .getByRole("link", { name: "Open in the deck builder" })
      .tap();
    await expect(page).toHaveURL(`${origin}/decks/${deckId}`);
    await page.getByRole("button", { name: "Publish", exact: true }).tap();
    const publishing = page.getByRole("dialog", {
      name: /^(Publish|Published Deck)$/,
    });
    await publishing.getByLabel("Public title").fill("Mobile public snapshot");
    await publishing
      .getByRole("button", { name: "Publish Unlisted snapshot", exact: true })
      .tap();
    const link = publishing.getByRole("link", { name: "View public snapshot" });
    await expect(link).toBeVisible();
    const url = (await link.getAttribute("href"))!;
    await publicPage.goto(
      `${process.env.TEST_ORIGIN || "http://localhost:5173"}` + url
    );
    await expect(publicPage.getByRole("main")).toContainText("3 cards");
    await expect(publicPage.getByRole("main")).not.toContainText(name);
    expect(
      (
        await anonymous.request.get(
          `${process.env.TEST_ORIGIN || "http://localhost:5173"}/api/catalog/status`
        )
      ).status()
    ).toBe(401);
    await add("1");
    await listHoldings(pool, name, 4);
    await publicPage.reload();
    await expect(publicPage.getByRole("main")).toContainText("3 cards");
    await publishing
      .getByRole("button", { name: "Republish snapshot", exact: true })
      .tap();
    await expect(publishing).toContainText(
      "Mobile public snapshot · Unlisted · version 2"
    );
    await publicPage.reload();
    await expect(publicPage.getByRole("main")).toContainText("4 cards");
    await publishing
      .getByRole("button", { name: "Revoke: Mobile public snapshot" })
      .tap();
    await publishing
      .getByRole("button", { name: "Revoke for good", exact: true })
      .tap();
    await expect(publishing).toContainText("revoked permanently");
    await publicPage.reload();
    await expect(
      publicPage.getByRole("heading", {
        level: 1,
        name: "This deck isn't published anymore",
      })
    ).toBeVisible();
  } finally {
    await anonymous.close();
    await pool.end();
  }
});
