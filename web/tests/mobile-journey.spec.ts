import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { listHoldings } from "./support/deck-list";
import { exemptNamedDeck } from "./support/publish-gate";
import { openDeckTools } from "./support/deck-builder";

test.use({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});
function messages(path: string): string[] {
  try {
    return readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

test("mobile collector can search, Add, Move, Undo, check and publish a physical Deck", async ({
  page,
  browser,
}) => {
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
    const mail = process.env.MAIL_FILE || "/tmp/tcg-ticket01-mail";
    const before = messages(mail).length;
    await page.goto(
      `${process.env.TEST_ORIGIN || "http://localhost:5173"}/locations`
    );
    await expect(page).toHaveURL(/\/collection(\?|$)/);
    await page
      .getByLabel("Email")
      .fill(process.env.OWNER_EMAIL || "owner@example.test");
    await page.getByRole("button", { name: "Send code" }).tap();
    await expect.poll(() => messages(mail).length).toBeGreaterThan(before);
    await page
      .getByLabel("Six-digit code")
      .fill(JSON.parse(messages(mail).at(-1)!).otp);
    await page.getByRole("button", { name: "Sign in" }).tap();
    await page
      .getByRole("navigation", { name: "Main views" })
      .getByRole("button", { name: "Decks", exact: true })
      .tap();
    const name = "Mobile private " + randomUUID().slice(0, 8);
    await page.getByLabel("Deck name").fill(name);
    await page.getByRole("button", { name: "Create Deck", exact: true }).tap();
    await openDeckTools(page);
    const holdings = page.getByRole("region", { name: `Cards in ${name}` });
    const checks = page.getByRole("region", { name: `Checks for ${name}` });
    await expect(checks).toContainText("0 cards · 60 cards short of 60");
    async function add(quantity: string) {
      await holdings
        .getByRole("button", { name: "Add cards", exact: true })
        .tap();
      await holdings.getByLabel("Search English card name").fill("Pika");
      await holdings.getByRole("button", { name: "Search", exact: true }).tap();
      await holdings
        .getByLabel("Card Edition")
        .selectOption({ label: "Pikachu · Fixture Set #1 · finish: normal" });
      await holdings.getByLabel("Quantity", { exact: true }).fill(quantity);
      await holdings
        .getByRole("button", { name: "Add to Location", exact: true })
        .tap();
    }
    await add("3");
    await expect(checks).toContainText("3 cards · 57 cards short of 60");
    const move = holdings.getByRole("region", { name: "Move cards" });
    await move.getByRole("button", { name: "Fan copies", exact: true }).tap();
    await move
      .getByRole("button", { name: "Select 2 Pikachu copies", exact: true })
      .tap();
    await move
      .getByRole("button", { name: "Move selected", exact: true })
      .tap();
    // Destinations are labelled by full path, so exact "Unsorted" is the top-level leaf, never "Box / Unsorted".
    await page
      .getByRole("dialog", { name: "Choose Move destination" })
      .getByRole("button", { name: "Unsorted", exact: true })
      .tap();
    await expect(checks).toContainText("1 cards · 59 cards short of 60");
    // The undo list refreshes after the counts; tapping before it does can
    // latch onto an earlier test's entry, which then becomes non-newest.
    await expect(
      move.getByText("Moved 2 copies across 1 Editions.")
    ).toBeVisible();
    await move.getByRole("button", { name: "Undo", exact: true }).first().tap();
    await expect(checks).toContainText("3 cards · 57 cards short of 60");
    // Publishing freezes the Deck List; list the cards the Deck holds.
    await listHoldings(pool, name, 3);
    await exemptNamedDeck(pool, name); // not a legal Deck List in any Format
    const publishing = page.getByRole("region", {
      name: "Publish Deck",
      exact: true,
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
    await expect(publicPage.getByRole("main")).toContainText(
      "3 cards · 57 cards short of 60"
    );
    await expect(publicPage.getByRole("main")).not.toContainText(name);
    expect(
      (
        await anonymous.request.get(
          `${process.env.TEST_ORIGIN || "http://localhost:5173"}/api/catalog/status`
        )
      ).status()
    ).toBe(401);
    await add("1");
    await expect(checks).toContainText("4 cards · 56 cards short of 60");
    await listHoldings(pool, name, 4);
    await publicPage.reload();
    await expect(publicPage.getByRole("main")).toContainText("3 cards");
    await publishing
      .getByRole("button", { name: "Republish snapshot", exact: true })
      .tap();
    await expect(publishing).toContainText("Snapshot version 2");
    await publicPage.reload();
    await expect(publicPage.getByRole("main")).toContainText(
      "4 cards · 56 cards short of 60"
    );
    await publishing
      .getByRole("button", { name: "Revoke public link", exact: true })
      .tap();
    await expect(publishing.getByRole("status")).toContainText(
      "revoked permanently"
    );
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
