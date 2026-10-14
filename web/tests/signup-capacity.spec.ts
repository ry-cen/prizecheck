import { test, expect } from "@playwright/test";
import { Pool } from "pg";
import { signInAsOwner } from "./support/sign-in";

// The owner panel shows the last day's new accounts against DAILY_SIGNUP_CAP, which the stacks leave at its default of
// 100, and warns at 80% (#155).
const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";
const OWNER_EMAIL = process.env.OWNER_EMAIL || "owner@example.test";

test("the owner panel warns when the day's new accounts reach 80% of the cap, and not below", async ({
  page,
}) => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await signInAsOwner(page, "/collection");
    const owner = await pool.query('SELECT id FROM "user" WHERE email=$1', [
      OWNER_EMAIL,
    ]);
    await pool.query("DELETE FROM owner_binding");
    await pool.query("INSERT INTO owner_binding(user_id) VALUES($1)", [
      owner.rows[0].id,
    ]);
    // signInAsOwner cleared auth_rate_event, so these are the day's only signups.
    await pool.query(
      "INSERT INTO auth_rate_event(kind,ip_key) SELECT 'signup','key-'||g FROM generate_series(1,79) g"
    );
    await page.goto(`${ORIGIN}/owner`);
    // Owner controls' Status tab (#167): operational health is a table, and a warning joins the problems line.
    const health = page.getByRole("region", { name: "Operational health" });
    const row = health
      .getByRole("region", { name: "Health checks" })
      .getByRole("row")
      .filter({
        has: page.getByRole("cell", { name: "New accounts", exact: true }),
      });
    await expect(row).toContainText("79 / 100");
    await expect(row).toContainText("Refused for too many sign-ins:");
    await expect(row).not.toContainText("80% warning");
    await pool.query(
      "INSERT INTO auth_rate_event(kind,ip_key) VALUES('signup','key-80')"
    );
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(row).toContainText("80 / 100 · 80% warning");
    await expect(
      page
        .getByRole("list", { name: "Problems" })
        .getByRole("listitem")
        .filter({ hasText: "New accounts: 80 / 100 · 80% warning" })
    ).toBeVisible();
    await expect(health).not.toContainText(OWNER_EMAIL);
  } finally {
    await pool.query("DELETE FROM auth_rate_event");
    await pool.end();
  }
});
