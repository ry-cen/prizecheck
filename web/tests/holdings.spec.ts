// Add moved from the old Locations page to the workspace in ticket 114.
import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { Pool } from "pg";

test("collector adds an exact Edition to a Storage Leaf using keyboard controls", async ({
  page,
}) => {
  execFileSync(
    ".venv/bin/python",
    [
      "-c",
      `from test_catalog_search import promote
promote({'card-1': 'Pikachu'})`,
    ],
    { env: { ...process.env, PYTHONPATH: "api:api/tests" } }
  );
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query("DELETE FROM auth_send_event");
  try {
    await page.goto(
      `${process.env.TEST_ORIGIN || "http://localhost:5173"}/collection`
    );
    await page
      .getByLabel("Email")
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
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(
      page.getByRole("heading", { name: "All owned" })
    ).toBeVisible();
    const leaf = `Keys ${randomUUID().slice(0, 8)}`;
    await page
      .getByRole("button", { name: "Add location", exact: true })
      .focus();
    await page.keyboard.press("Enter");
    await page.keyboard.type(leaf);
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("heading", { level: 1, name: leaf })
    ).toBeVisible();
    await page.getByRole("button", { name: "Add cards", exact: true }).focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: `Add cards to ${leaf}` });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("Search English card name")).toBeFocused();
    await page.keyboard.type("Pika");
    await page.keyboard.press("Enter");
    const edition = dialog.getByLabel("Card Edition");
    await edition.selectOption({
      label: "Pikachu · Fixture Set #1 · finish: normal",
    });
    await edition.focus();
    await page.keyboard.press("Tab");
    await expect(dialog.getByLabel("Quantity")).toBeFocused();
    await dialog.getByLabel("Quantity").fill("3");
    await page.keyboard.press("Enter");
    await expect(dialog.getByRole("status")).toHaveText(
      `Added. This stack now has 3 copies in ${leaf}.`
    );
    await edition.selectOption({
      label: "Pikachu · Fixture Set #1 · finish: normal",
    });
    await dialog.getByLabel("Quantity").fill("2");
    await page.keyboard.press("Enter");
    await expect(dialog.getByRole("status")).toHaveText(
      `Added. This stack now has 5 copies in ${leaf}.`
    );
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Add cards", exact: true })
    ).toBeFocused();
    await expect(page.getByRole("main")).toContainText("5 copies · 1 edition");
    await expect(
      page.getByRole("region", { name: "Cards" }).getByRole("button")
    ).toHaveCount(5);
  } finally {
    await pool.end();
  }
});
