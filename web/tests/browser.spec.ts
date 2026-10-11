import { test, expect } from "@playwright/test";
import { readFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { Pool } from "pg";

test("owner signs in, sees Unsorted, follows safe destination, then signs out", async ({
  page,
}) => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query("DELETE FROM auth_send_event");
  const email = process.env.OWNER_EMAIL || "owner@example.test";
  await page.goto(
    `${process.env.TEST_ORIGIN || "http://localhost:5173"}/locations?next=%2Flocations`
  );
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Send code" }).click();
  await expect(page.getByRole("status")).toContainText("code has been sent");
  const lines = readFileSync(
    process.env.MAIL_FILE || "/tmp/tcg-ticket01-mail",
    "utf8"
  )
    .trim()
    .split("\n");
  const code = JSON.parse(lines.at(-1)!).otp;
  await page.getByLabel("Six-digit code").fill(code);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(
    `${process.env.TEST_ORIGIN || "http://localhost:5173"}/workspace`
  );
  await expect(page.getByRole("heading", { name: "All owned" })).toBeVisible();
  await expect(
    page
      .getByRole("navigation", { name: "Locations" })
      .getByRole("button", { name: "Unsorted", exact: true })
      .first()
  ).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "All owned" })).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("button", { name: "Send code" })).toBeVisible();
  await expect(page).toHaveURL(
    `${process.env.TEST_ORIGIN || "http://localhost:5173"}/workspace`
  );
  await pool.end();
});

test("external return destinations are discarded", async ({ page }) => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query("DELETE FROM auth_send_event");
  const email = process.env.OWNER_EMAIL || "owner@example.test";
  await page.goto(
    `${process.env.TEST_ORIGIN || "http://localhost:5173"}/locations?next=https%3A%2F%2Fexample.com%2Fsteal`
  );
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Send code" }).click();
  await expect(page.getByRole("status")).toContainText("code has been sent");
  const lines = readFileSync(
    process.env.MAIL_FILE || "/tmp/tcg-ticket01-mail",
    "utf8"
  )
    .trim()
    .split("\n");
  await page.getByLabel("Six-digit code").fill(JSON.parse(lines.at(-1)!).otp);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(
    `${process.env.TEST_ORIGIN || "http://localhost:5173"}/workspace`
  );
  await pool.end();
});

test("bound owner starts one catalog run from the private panel", async ({
  page,
}) => {
  const gate = process.env.CATALOG_PROCESS_FIXTURE_DIR;
  if (!gate)
    throw new Error(
      "Configure the CI deterministic catalog child source before this test"
    );
  mkdirSync(gate, { recursive: true });
  rmSync(`${gate}/release`, { force: true });
  execFileSync(
    ".venv/bin/python",
    ["-c", "from test_catalog import reset_catalog; reset_catalog()"],
    { env: { ...process.env, PYTHONPATH: "api:api/tests" } }
  );
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query("DELETE FROM auth_send_event");
  await pool.query("DELETE FROM owner_binding");
  await pool.query(
    "UPDATE catalog_run SET phase='failed',outcome='failed',finished_at=now() WHERE outcome IS NULL"
  );
  const email = process.env.OWNER_EMAIL || "owner@example.test";
  await page.goto(
    `${process.env.TEST_ORIGIN || "http://localhost:5173"}/locations`
  );
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Send code" }).click();
  await expect(page.getByRole("status")).toContainText("code has been sent");
  const lines = readFileSync(
    process.env.MAIL_FILE || "/tmp/tcg-ticket01-mail",
    "utf8"
  )
    .trim()
    .split("\n");
  await page.getByLabel("Six-digit code").fill(JSON.parse(lines.at(-1)!).otp);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "All owned" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Owner controls" })
  ).toHaveCount(0);
  const result = await pool.query('SELECT id FROM "user" WHERE email=$1', [
    email,
  ]);
  await pool.query(
    "INSERT INTO owner_binding(singleton,user_id) VALUES(true,$1)",
    [result.rows[0].id]
  );
  await page.reload();
  await page.getByRole("button", { name: "Owner controls" }).click();
  await expect(
    page.getByRole("heading", { name: "English catalog pull" })
  ).toBeVisible();
  await page.getByRole("button", { name: "Start full English pull" }).click();
  await expect(page.getByText(/Phase: (queued|enumerating)/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Start full English pull" })
  ).toBeDisabled();
  expect(
    (
      await pool.query(
        "SELECT count(*) AS n FROM catalog_run WHERE outcome IS NULL"
      )
    ).rows[0].n
  ).toBe("1");
  await page.goto("about:blank");
  writeFileSync(`${gate}/release`, "released");
  await expect
    .poll(
      async () =>
        (
          await pool.query(
            "SELECT outcome FROM catalog_run ORDER BY started_at DESC LIMIT 1"
          )
        ).rows[0]?.outcome
    )
    .toBe("succeeded");
  await page.goto(
    `${process.env.TEST_ORIGIN || "http://localhost:5173"}/locations`
  );
  await page.getByRole("button", { name: "Owner controls" }).click();
  await expect(page.getByText("Phase: complete")).toBeVisible();
  await pool.end();
});
