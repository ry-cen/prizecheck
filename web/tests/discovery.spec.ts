import { test, expect, type Page } from "@playwright/test";
import { signInAsOwner } from "./support/sign-in";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { listHoldings } from "./support/deck-list";
import {
  exemptFromDiscover,
  exemptNamedDeck,
  showAsLegal,
} from "./support/publish-gate";

const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";

/** Stores `quantity` copies of the catalog's one Pikachu Edition in the Deck through the gateway. */
async function addToDeck(page: Page, deckId: string, quantity: number) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  let edition: string;
  try {
    edition = (
      await pool.query(
        `SELECT e.id FROM catalog_edition e JOIN catalog_printing p ON p.id=e.printing_id
         WHERE p.source_id='card-1' ORDER BY e.descriptor->>'finish'='normal' DESC LIMIT 1`
      )
    ).rows[0].id;
  } finally {
    await pool.end();
  }
  const added = await page.request.post(`${ORIGIN}/api/holdings`, {
    headers: { origin: ORIGIN },
    data: {
      location_id: deckId,
      edition_id: edition,
      quantity: String(quantity),
      idempotency_key: randomUUID(),
    },
  });
  expect(added.status()).toBe(200);
}

/** The deck builder's Publish dialog, titled "Publish" before publishing and "Published Deck" after. */
const publishDialog = (page: Page) =>
  page.getByRole("dialog", { name: /^(Publish|Published Deck)$/ });

test("Listed discovery opt-in and removal preserve snapshot, privacy, and escaped source text", async ({
  page,
  browser,
}) => {
  const hostileName = "Pikachu <img src=x onerror=window.publicInjected=1>";
  execFileSync(
    ".venv/bin/python",
    [
      "-c",
      `from test_catalog_search import promote
promote({'card-1': ${JSON.stringify(hostileName)}})`,
    ],
    { env: { ...process.env, PYTHONPATH: "api:api/tests" } }
  );
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const anonymous = await browser.newContext();
  const publicPage = await anonymous.newPage();
  try {
    await pool.query("DELETE FROM auth_send_event");
    await signInAsOwner(page, "/collection");
    await page.getByRole("button", { name: "Decks", exact: true }).click();
    const suffix = randomUUID().slice(0, 8);
    const privateName = `Hidden ${suffix}`;
    const title = `Public & friends ${suffix}`;
    await page.getByLabel("Deck name").fill(privateName);
    await page
      .getByRole("button", { name: "Create Deck", exact: true })
      .click();
    // The deck builder has no Holdings panel (#181): cards reach the Deck through the gateway, as Collection adds them.
    await expect(page).toHaveURL(/\/decks\/[^/?#]+$/);
    const deckId = page.url().split("/").at(-1)!;
    await addToDeck(page, deckId, 59);
    // Publishing freezes the Deck List; list the cards just added.
    await listHoldings(pool, privateName, 59);
    await exemptNamedDeck(pool, privateName); // not a legal Deck List in any Format
    // Publish waits for a legal result; the exempt Deck is shown to the page as legal (support/publish-gate.ts).
    await showAsLegal(page, deckId);
    await page.reload();
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    const publishing = publishDialog(page);
    await publishing
      .getByLabel("Public title")
      .fill("<script>window.publicInjected=1</script>");
    await publishing
      .getByRole("button", { name: "Publish Unlisted snapshot", exact: true })
      .click();
    await expect(publishing).toContainText("plain-text public title");
    await publishing.getByLabel("Public title").fill(title);
    await publishing
      .getByRole("button", { name: "Publish Unlisted snapshot", exact: true })
      .click();
    const link = publishing.getByRole("link", { name: "View public snapshot" });
    await expect(link).toBeVisible();
    const publicUrl = (await link.getAttribute("href"))!;
    // Discover lists only legal decks (#182); this 59-card list isn't one.
    exemptFromDiscover(publicUrl.split("/").at(-1)!);
    const searchDecks = publicPage.getByRole("searchbox", {
      name: "Search decks",
    });
    await publicPage.goto(
      `${process.env.TEST_ORIGIN || "http://localhost:5173"}/discover`
    );
    await searchDecks.fill(title);
    await expect(publicPage.getByRole("main")).toContainText(
      "No legal decks match this search."
    );
    await publishing
      .getByRole("button", { name: "List in Discover", exact: true })
      .click();
    await expect(publishing).toContainText(`${title} · Listed · version 1`);
    await publicPage.reload();
    await searchDecks.fill(title);
    await expect(
      publicPage.getByRole("link", { name: title, exact: true })
    ).toBeVisible();
    await expect(publicPage.getByRole("main")).not.toContainText(privateName);
    await publicPage.getByRole("link", { name: title, exact: true }).click();
    await expect(
      publicPage.getByRole("heading", { name: title, exact: true })
    ).toBeVisible();
    // Card names are text, never markup: the List view shows each line's name (#183).
    await publicPage
      .getByRole("radiogroup", { name: "Deck List view" })
      .getByRole("radio", { name: "List" })
      .click();
    await expect(publicPage.getByRole("main")).toContainText(hostileName);
    await expect(publicPage.locator('img[src="x"]')).toHaveCount(0);
    expect(
      await publicPage.evaluate(
        () =>
          (window as typeof window & { publicInjected?: number }).publicInjected
      )
    ).toBeUndefined();
    await expect(publicPage.locator('meta[name="robots"]')).toHaveAttribute(
      "content",
      "index, follow"
    );
    expect(
      await (
        await anonymous.request.get(
          `${process.env.TEST_ORIGIN || "http://localhost:5173"}/api/public/sitemap.xml`
        )
      ).text()
    ).toContain(publicUrl);
    await publishing
      .getByRole("button", { name: "Make Unlisted", exact: true })
      .click();
    await expect(publishing).toContainText(`${title} · Unlisted · version 1`);
    await publicPage.reload();
    await expect(publicPage.locator('meta[name="robots"]')).toHaveAttribute(
      "content",
      "noindex, nofollow"
    );
    await expect(
      publicPage.getByRole("heading", { name: title, exact: true })
    ).toBeVisible();
    await publicPage.goto(
      `${process.env.TEST_ORIGIN || "http://localhost:5173"}/discover`
    );
    await searchDecks.fill(title);
    await expect(publicPage.getByRole("main")).toContainText(
      "No legal decks match this search."
    );
    expect(
      await (
        await anonymous.request.get(
          `${process.env.TEST_ORIGIN || "http://localhost:5173"}/api/public/sitemap.xml`
        )
      ).text()
    ).not.toContain(publicUrl);
  } finally {
    await anonymous.close();
    await pool.end();
  }
});

// @slow (capacity): publishes 32 Decks.
test(
  "anonymous discovery pages and refreshes a stale cursor",
  { tag: "@slow" },
  async ({ page }) => {
    const prefix = `Paging ${randomUUID().slice(0, 8)}`;
    execFileSync(
      ".venv/bin/python",
      [
        "-c",
        `from test_holdings import fixture, add
from test_decks import create
from test_publications import command
from test_discovery import visibility
owner, _, _, _, edition, _ = fixture()
for index in range(32):
    deck = create(owner, ${JSON.stringify(prefix)} + str(index)).json()['location']['id']
    add(owner, deck, edition, '1')
    command(owner, deck, title=${JSON.stringify(prefix)} + f' {index:02}')
    visibility(owner, deck, 'listed')`,
      ],
      { env: { ...process.env, PYTHONPATH: "api:api/tests" } }
    );
    const decks = page
      .getByRole("list", { name: "Decks" })
      .getByRole("listitem");
    const searchDecks = page.getByRole("searchbox", { name: "Search decks" });
    await page.goto(
      `${process.env.TEST_ORIGIN || "http://localhost:5173"}/discover`
    );
    await searchDecks.fill(prefix);
    await expect(decks).toHaveCount(30);
    await page.getByRole("button", { name: "More decks", exact: true }).click();
    await expect(decks).toHaveCount(32);
    await page.reload();
    await searchDecks.fill(prefix);
    await expect(decks).toHaveCount(30);
    execFileSync(
      ".venv/bin/python",
      [
        "-c",
        `from test_holdings import fixture
from test_decks import create
from test_publications import command
from test_discovery import visibility
owner, _, _, _, _, _ = fixture()
deck = create(owner, ${JSON.stringify(prefix)} + 'new').json()['location']['id']
command(owner, deck, title=${JSON.stringify(prefix)} + ' new')
visibility(owner, deck, 'listed')`,
      ],
      { env: { ...process.env, PYTHONPATH: "api:api/tests" } }
    );
    await page.getByRole("button", { name: "More decks", exact: true }).click();
    await expect(page.getByRole("status")).toContainText(
      "Published decks changed. Showing the first page."
    );
    await expect(decks).toHaveCount(30);
    await expect(
      page.getByRole("link", { name: prefix + " new", exact: true })
    ).toBeVisible();
  }
);
