import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { Pool } from "pg";

test("collector searches Collection totals and opens physical leaf distribution", async ({
  page,
}) => {
  execFileSync(
    ".venv/bin/python",
    [
      "-c",
      `from test_catalog_search import promote
promote({'collection-1':'Collection Pikachu'})`,
    ],
    { env: { ...process.env, PYTHONPATH: "api:api/tests" } }
  );
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query("DELETE FROM auth_send_event");
  try {
    await page.goto(
      process.env.TEST_ORIGIN
        ? `${process.env.TEST_ORIGIN}/locations`
        : `${process.env.TEST_ORIGIN || "http://localhost:5173"}/locations`
    );
    await expect(page).toHaveURL(/\/collection(\?|$)/);
    await page
      .getByLabel("Email", { exact: true })
      .fill(process.env.OWNER_EMAIL || "owner@example.test");
    await page.getByRole("button", { name: "Send code" }).click();
    await expect(page.getByRole("status")).toContainText("code has been sent");
    const lines = readFileSync(
      process.env.MAIL_FILE || "/tmp/tcg-ticket01-mail",
      "utf8"
    )
      .trim()
      .split("\n");
    await page.getByLabel("Six-digit code").fill(JSON.parse(lines.at(-1)!).otp);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(
      page.getByRole("navigation", { name: "Main views" })
    ).toBeVisible();
    const owner = (
      await pool.query('SELECT id FROM "user" WHERE email=$1', [
        process.env.OWNER_EMAIL || "owner@example.test",
      ])
    ).rows[0].id;
    const leaf = (
      await pool.query(
        "SELECT id FROM location WHERE owner_id=$1 AND kind='storage_leaf' ORDER BY created_at LIMIT 1",
        [owner]
      )
    ).rows[0].id;
    const edition = (
      await pool.query(
        "SELECT e.id FROM catalog_edition e JOIN catalog_printing p ON p.id=e.printing_id WHERE p.source_id='collection-1' ORDER BY e.descriptor_key LIMIT 1"
      )
    ).rows[0].id;
    await pool.query(
      "INSERT INTO holding(owner_id,location_id,edition_id,quantity,version) VALUES($1,$2,$3,7,1) ON CONFLICT(owner_id,location_id,edition_id) DO UPDATE SET quantity=7",
      [owner, leaf, edition]
    );
    // The old Collection page is retired (#164): Collection finds the copies, and its inspector lists
    // the Storage Leaf that holds them.
    await page.reload();
    const search = page.getByRole("searchbox", { name: "Search cards" });
    // The search is debounced and clears the selection when it lands, so wait for its listing before
    // selecting a tile.
    const searched = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/collection/holdings" &&
        new URL(response.url()).searchParams.toString().includes("Collection")
    );
    await search.fill("Collection Pika");
    await searched;
    await expect(
      page.getByRole("main").getByText("7 copies · 1 edition", { exact: true })
    ).toBeVisible();
    const tiles = page
      .getByRole("region", { name: "Cards" })
      .getByRole("button");
    await expect(tiles).toHaveCount(7);
    await tiles.first().click();
    const details = page.getByRole("complementary", { name: "Card details" });
    await expect(details).toContainText("7 copies owned");
    await expect(
      details
        .getByRole("list", { name: "Copies by location" })
        .getByRole("listitem")
    ).toHaveText([/^7 in /]);
    await search.fill("Missing owned card");
    await expect(
      page.getByText("No cards match your search or filters.")
    ).toBeVisible();
  } finally {
    await pool.end();
  }
});
