// Add moved from the old Locations page to the workspace in ticket 114, and onto Catalog's Add mode in #175.
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
    // Add cards (#175) is Catalog's gallery in Add mode, set to the open Storage Leaf: queue with the keyboard, then
    // Add N cards, which closes it and returns focus to Add cards.
    const opener = page.getByRole("button", { name: "Add cards", exact: true });
    await opener.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: `Add cards to ${leaf}` });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole("searchbox", { name: "Search the catalog" })
    ).toBeFocused();
    await page.keyboard.type("Pika");
    const results = dialog.getByRole("region", { name: "Catalog results" });
    const more = results.getByRole("button", {
      name: "One more Pikachu fixture 1 Normal",
      exact: true,
    });
    await expect(more).toHaveCount(1);
    await more.focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    const bar = dialog.getByRole("region", { name: "Add to a Location" });
    await expect(bar.getByRole("listitem")).toHaveText([
      "3× Pikachu fixture 1 Normal",
    ]);
    await bar.getByRole("button", { name: "Add 3 cards" }).focus();
    await page.keyboard.press("Enter");
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
    await expect(page.getByRole("main")).toContainText("3 copies · 1 edition");

    await page.keyboard.press("Enter");
    await expect(dialog).toBeVisible();
    await page.keyboard.type("Pika");
    await expect(more).toHaveCount(1);
    await more.focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await bar.getByRole("button", { name: "Add 2 cards" }).focus();
    await page.keyboard.press("Enter");
    await expect(dialog).toHaveCount(0);
    await expect(
      page.getByRole("region", { name: "Notifications" }).getByRole("paragraph")
    ).toHaveText(`Added 2 cards to ${leaf}.`);
    await expect(page.getByRole("main")).toContainText("5 copies · 1 edition");
    await expect(
      page.getByRole("region", { name: "Cards" }).getByRole("button")
    ).toHaveCount(5);

    // Escape closes it, adding nothing, and focus returns to Add cards.
    await opener.focus();
    await page.keyboard.press("Enter");
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
    await expect(page.getByRole("main")).toContainText("5 copies · 1 edition");
  } finally {
    await pool.end();
  }
});
