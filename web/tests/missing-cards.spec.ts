import { test, expect } from "@playwright/test";
import { signInAsOwner } from "./support/sign-in";
import { execFileSync } from "node:child_process";
import { Pool } from "pg";

test("owner reviews a private missing Printing and approves it in one step", async ({
  page,
}) => {
  execFileSync(
    ".venv/bin/python",
    [
      "-c",
      `from test_catalog_search import promote
promote({'fixture-1': 'Pikachu'})`,
    ],
    { env: { ...process.env, PYTHONPATH: "api:api/tests" } }
  );
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await signInAsOwner(page, "/collection");
    await expect(
      page.getByRole("button", { name: "Catalog", exact: true })
    ).toBeVisible();
    const owner = await pool.query<{ id: string }>(
      'SELECT id FROM "user" WHERE email=$1',
      [process.env.OWNER_EMAIL || "owner@example.test"]
    );
    await pool.query(
      "INSERT INTO owner_binding(singleton,user_id) VALUES (true,$1) ON CONFLICT(singleton) DO UPDATE SET user_id=EXCLUDED.user_id",
      [owner.rows[0].id]
    );
    await page.reload();
    await page.getByRole("button", { name: "Account" }).click();
    await expect(
      page.getByRole("menuitem", { name: "Owner controls" })
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Card reports" }).click();
    await page
      .getByRole("tablist", { name: "Card reports sections" })
      .getByRole("tab", { name: "Report a card", exact: true })
      .click();
    const report = page.getByRole("tabpanel", { name: "Report a card" });
    await report.getByLabel("Set ID").fill("Jungle");
    await report.getByLabel("Set name").fill("Jungle");
    await report.getByLabel("Collector number").fill("99");
    await report.getByLabel("English name").fill("Pikachu");
    await report
      .getByLabel("Evidence link")
      .fill("https://example.org/jungle-card");
    await report.getByRole("button", { name: "Send private report" }).click();
    await expect(page.getByRole("main").getByRole("status")).toContainText(
      "Report sent privately"
    );
    // Sending opens My reports, newest first; earlier runs on this stack may have left their own Jungle #99.
    await expect(
      page
        .getByRole("region", { name: "Reports you sent", exact: true })
        .getByRole("row")
        .filter({ hasText: "Pikachu · Jungle #99" })
        .first()
    ).toContainText("Pending");
    await page.getByRole("button", { name: "Account" }).click();
    await page.getByRole("menuitem", { name: "Owner controls" }).click();
    await page.getByRole("tab", { name: /^Missing cards/ }).click();
    await expect(page).toHaveURL(/\/owner\/missing$/);
    const queue = page.getByRole("region", {
      name: "Missing-card review queue",
    });
    // The queue is a table (#168); Review opens the report's card in a row under it. Reports come newest
    // first, so the first "Pikachu · Jungle #99" is this test's.
    await queue
      .getByRole("button", { name: "Review Pikachu · Jungle #99" })
      .first()
      .click();
    const item = queue.getByRole("article", { name: "Pikachu · Jungle #99" });
    await expect(item.getByLabel("Review reason")).toBeFocused();
    await expect(item.getByLabel("Review evidence URL")).toHaveCount(0);
    await item
      .getByLabel("Review reason")
      .fill("Verified set and printed number");
    await item.getByRole("button", { name: "Approve shared record" }).click();
    // A confirmed decision removes the row and says so in a toast.
    await expect(
      page.getByRole("region", { name: "Notifications" })
    ).toContainText("Approved shared record: Pikachu · Jungle #99.");
    await expect(item).toHaveCount(0);
    await page.getByRole("button", { name: "Catalog", exact: true }).click();
    // The approved card is in Catalog's gallery (#173); its card popup (#174) names the owner-reviewed source, and its
    // Edition carries the Owner reviewed badge.
    await page
      .getByRole("searchbox", { name: "Search the catalog" })
      .fill("Pikachu");
    await page
      .getByRole("region", { name: "Catalog results" })
      .getByRole("button", { name: /^Pikachu, Jungle 99,/ })
      .first()
      .click();
    const popup = page.getByRole("dialog", { name: "Pikachu" });
    await expect(popup.getByText("Owner reviewed manual record")).toBeVisible();
    await expect(
      popup.getByRole("group", { name: "Editions" }).getByRole("button")
    ).toContainText("Owner reviewed");
  } finally {
    await pool.end();
  }
});
