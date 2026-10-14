import { test, expect } from "@playwright/test";
import { signInAsOwner } from "./support/sign-in";
import { Pool } from "pg";

test("owner sees stale backup and allowance warning in operational health", async ({
  page,
}) => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query("DELETE FROM auth_send_event");
    await pool.query("DELETE FROM owner_binding");
    await pool.query(
      "UPDATE operations_state SET backup_last_success=now()-interval '26 hours',backup_stale=true,watchdog_last_check=now(),backup_alerts=1"
    );
    await pool.query(
      "INSERT INTO operations_quota(resource,used,allowance) VALUES('database_bytes',70,100) ON CONFLICT(resource) DO UPDATE SET used=70,allowance=100,measured_at=now()"
    );
    const email = process.env.OWNER_EMAIL || "owner@example.test";
    await signInAsOwner(page, "/owner");
    await expect(
      page.getByRole("navigation", { name: "Main views" })
    ).toBeVisible();
    const owner = await pool.query('SELECT id FROM "user" WHERE email=$1', [
      email,
    ]);
    await expect
      .poll(
        async () =>
          (
            await pool.query(
              "SELECT count(*) AS n FROM inventory_owner WHERE user_id=$1",
              [owner.rows[0].id]
            )
          ).rows[0].n
      )
      .toBe("1");
    await pool.query("INSERT INTO owner_binding(user_id) VALUES($1)", [
      owner.rows[0].id,
    ]);
    await page.reload();
    // Owner controls opens on Status (#167): operational health is a table of area, check, value and detail.
    const health = page.getByRole("region", { name: "Operational health" });
    await expect(
      health.getByRole("heading", { name: "Operational health" })
    ).toBeVisible();
    const table = health.getByRole("region", { name: "Health checks" });
    const row = (check: string) =>
      table
        .getByRole("row")
        .filter({ has: page.getByRole("cell", { name: check, exact: true }) });
    await expect(row("Backup")).toContainText("Stale");
    await expect(row("Backup watchdog")).toContainText(
      "Stale backup alerts: 1"
    );
    await expect(row("database_bytes")).toContainText("70 / 100 · 70% warning");
    // The problems line lists both, the stale backup (bad) before the allowance warning (warn).
    const problems = page.getByRole("list", { name: "Problems" });
    // Read the line again until it settles: the operational status loads after the page.
    await expect
      .poll(async () => {
        const listed = await problems.getByRole("listitem").allTextContents();
        const backup = listed.indexOf("Backup: Stale");
        const allowance = listed.indexOf(
          "database_bytes: 70 / 100 · 70% warning"
        );
        return {
          backup: backup >= 0,
          allowanceAfterBackup: allowance > backup,
        };
      })
      .toEqual({ backup: true, allowanceAfterBackup: true });
    await expect(health).not.toContainText(email);
    await expect(problems).not.toContainText(email);
  } finally {
    await pool.end();
  }
});
