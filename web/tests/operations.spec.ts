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
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
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
    const health = page.getByRole("region", { name: "Operational health" });
    await expect(
      health.getByRole("heading", { name: "Operational health" })
    ).toBeVisible();
    await expect(health.getByText(/Backup: stale/)).toBeVisible();
    await expect(health.getByText(/Stale backup alerts: 1/)).toBeVisible();
    await expect(
      health.getByText(/database_bytes: 70 \/ 100.*70% warning/)
    ).toBeVisible();
    await expect(health).not.toContainText(email);
  } finally {
    await pool.end();
  }
});
