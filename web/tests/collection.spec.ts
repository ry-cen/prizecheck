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
    await page.goto(new URL("/old-collection", page.url()).href);
    await page.getByLabel("Owned card name").fill("Collection Pika");
    await page.getByRole("button", { name: "Filter Collection" }).click();
    const row = page
      .getByRole("listitem")
      .filter({ hasText: "Collection Pikachu" })
      .first();
    await expect(row).toContainText("7 copies");
    await row.getByRole("button", { name: "Find copies" }).click();
    await expect(
      page.getByRole("dialog", { name: "Physical copies" })
    ).toContainText("7 copies");
    await page.getByRole("button", { name: "Close distribution" }).click();
    await page.getByLabel("Owned card name").fill("Missing owned card");
    await page.getByRole("button", { name: "Filter Collection" }).click();
    await expect(page.getByText("No owned Editions match.")).toBeVisible();
  } finally {
    await pool.end();
  }
});
