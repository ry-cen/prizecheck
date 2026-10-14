import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { listHoldings } from "./support/deck-list";
import { exemptFromDiscover, exemptNamedDeck } from "./support/publish-gate";
import { openDeckTools } from "./support/deck-builder";

function messages(path: string): string[] {
  try {
    return readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

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
    const mail = process.env.MAIL_FILE || "/tmp/tcg-ticket01-mail";
    const before = messages(mail).length;
    await page.goto(
      `${process.env.TEST_ORIGIN || "http://localhost:5173"}/locations`
    );
    await expect(page).toHaveURL(/\/collection(\?|$)/);
    await page
      .getByLabel("Email")
      .fill(process.env.OWNER_EMAIL || "owner@example.test");
    await page.getByRole("button", { name: "Send code" }).click();
    await expect.poll(() => messages(mail).length).toBeGreaterThan(before);
    await page
      .getByLabel("Six-digit code")
      .fill(JSON.parse(messages(mail).at(-1)!).otp);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByRole("button", { name: "Decks", exact: true }).click();
    const suffix = randomUUID().slice(0, 8);
    const privateName = `Hidden ${suffix}`;
    const title = `Public & friends ${suffix}`;
    await page.getByLabel("Deck name").fill(privateName);
    await page
      .getByRole("button", { name: "Create Deck", exact: true })
      .click();
    await openDeckTools(page);
    const holdings = page.getByRole("region", {
      name: `Cards in ${privateName}`,
    });
    await holdings
      .getByRole("button", { name: "Add cards", exact: true })
      .click();
    await holdings.getByLabel("Search English card name").fill("Pika");
    await holdings.getByRole("button", { name: "Search", exact: true }).click();
    await holdings.getByLabel("Card Edition").selectOption({ index: 1 });
    await holdings.getByLabel("Quantity", { exact: true }).fill("59");
    await holdings
      .getByRole("button", { name: "Add to Location", exact: true })
      .click();
    // Publishing freezes the Deck List; list the cards just added.
    await listHoldings(pool, privateName, 59);
    await exemptNamedDeck(pool, privateName); // not a legal Deck List in any Format
    const publishing = page.getByRole("region", {
      name: "Publish Deck",
      exact: true,
    });
    await publishing
      .getByLabel("Public title")
      .fill("<script>window.publicInjected=1</script>");
    await publishing
      .getByRole("button", { name: "Publish Unlisted snapshot", exact: true })
      .click();
    await expect(publishing.getByRole("status")).toContainText(
      "plain-text public title"
    );
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
      .getByRole("button", { name: "List in public discovery", exact: true })
      .click();
    await expect(publishing).toContainText("Snapshot version 1 · listed");
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
    await expect(publishing).toContainText("Snapshot version 1 · unlisted");
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
