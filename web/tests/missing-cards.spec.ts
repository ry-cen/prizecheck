import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { Pool } from "pg";

function mailLines(path: string): string[] {
  try {
    return readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

test("owner reviews a private missing Printing with a fresh approval code", async ({
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
  await pool.query("DELETE FROM auth_send_event");
  try {
    await page.goto(
      `${process.env.TEST_ORIGIN || "http://localhost:5173"}/locations`
    );
    await expect(page).toHaveURL(/\/collection(\?|$)/);
    const mailFile = process.env.MAIL_FILE || "/tmp/tcg-ticket01-mail";
    const beforeSignIn = mailLines(mailFile).length;
    await page
      .getByLabel("Email")
      .fill(process.env.OWNER_EMAIL || "owner@example.test");
    await page.getByRole("button", { name: "Send code" }).click();
    await expect(page.getByRole("status")).toContainText("code has been sent");
    await expect
      .poll(() => mailLines(mailFile).length)
      .toBeGreaterThan(beforeSignIn);
    await page
      .getByLabel("Six-digit code")
      .fill(JSON.parse(mailLines(mailFile).at(-1)!).otp);
    await page.getByRole("button", { name: "Sign in" }).click();
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
    await page.getByRole("button", { name: "Missing cards" }).click();
    const report = page.getByRole("region", { name: "Missing-card reports" });
    await report.getByLabel("Set ID").fill("Jungle");
    await report.getByLabel("Set name").fill("Jungle");
    await report.getByLabel("Collector number").fill("99");
    await report.getByLabel("English name").fill("Pikachu");
    await report
      .getByLabel("Evidence link")
      .fill("https://example.org/jungle-card");
    await report.getByRole("button", { name: "Send private report" }).click();
    await expect(report.getByRole("status")).toContainText(
      "Report sent privately"
    );
    await expect(report.getByText("pending")).toBeVisible();
    await page.getByRole("button", { name: "Account" }).click();
    await page.getByRole("menuitem", { name: "Owner controls" }).click();
    const queue = page.getByRole("region", {
      name: "Missing-card review queue",
    });
    const item = queue.getByRole("article").filter({ hasText: "Jungle #99" });
    await item
      .getByLabel("Review reason")
      .fill("Verified set and printed number");
    await pool.query(
      "UPDATE auth_send_event SET sent_at=now()-interval '61 seconds'"
    );
    const beforeApproval = mailLines(mailFile).length;
    await item.getByRole("button", { name: "Send approval code" }).click();
    await expect(item.getByRole("status")).toContainText(
      "Fresh approval code sent"
    );
    await expect
      .poll(() => mailLines(mailFile).length)
      .toBeGreaterThan(beforeApproval);
    await item
      .getByLabel("Fresh six-digit code")
      .fill(JSON.parse(mailLines(mailFile).at(-1)!).otp);
    await item.getByRole("button", { name: "Approve shared record" }).click();
    await expect(queue.getByText("approved")).toBeVisible();
    await page.getByRole("button", { name: "Catalog", exact: true }).click();
    await page.getByLabel("English name").fill("Pikachu");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page.getByText("Owner reviewed manual record")).toBeVisible();
  } finally {
    await pool.end();
  }
});
