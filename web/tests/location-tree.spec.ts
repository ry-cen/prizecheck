import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { Pool } from "pg";

test("collector organizes Locations on desktop and navigates the same tree on mobile", async ({
  page,
}) => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query("DELETE FROM auth_send_event");
  await page.goto(
    `${process.env.TEST_ORIGIN || "http://localhost:5173"}/locations`
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
    page.getByRole("navigation", { name: "Location tree" })
  ).toBeVisible();

  const suffix = Date.now().toString(36);
  const binder = `Binder ${suffix}`;
  const shelf = `Shelf ${suffix}`;
  const pageName = `Page ${suffix}`;
  await page.getByRole("button", { name: "New top-level Location" }).click();
  await page.locator(".location-form").getByLabel("Name").fill(binder);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(
    page.getByRole("heading", { name: binder, exact: true })
  ).toBeVisible();
  await page.getByRole("button", { name: "New child" }).click();
  await page.locator(".location-form").getByLabel("Name").fill(pageName);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(
    page.getByRole("navigation", { name: "Location breadcrumbs" })
  ).toContainText(binder);
  await expect(
    page.getByRole("navigation", { name: "Location breadcrumbs" })
  ).toContainText(pageName);
  await page.getByRole("button", { name: "Rename" }).click();
  await page
    .locator(".location-form")
    .getByLabel("Name")
    .fill(`Updated ${pageName}`);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(
    page.getByRole("heading", { name: `Updated ${pageName}`, exact: true })
  ).toBeVisible();
  await page.getByRole("button", { name: "New top-level Location" }).click();
  await page.locator(".location-form").getByLabel("Name").fill(shelf);
  await page.getByRole("button", { name: "Save" }).click();
  // Wait for the tree refresh so the Parent Location options include the shelf.
  await expect(
    page
      .getByRole("navigation", { name: "Location tree" })
      .getByRole("button", { name: shelf, exact: true })
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "Location tree" })
    .getByRole("button", { name: `Updated ${pageName}`, exact: true })
    .click();
  await page.getByRole("button", { name: "Move Location" }).click();
  await page
    .getByRole("combobox", { name: "Parent Location" })
    .selectOption({ label: shelf });
  await page.getByRole("button", { name: "Save" }).click();
  await expect(
    page.getByRole("navigation", { name: "Location breadcrumbs" })
  ).toContainText(shelf);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Browse Locations" }).click();
  await expect(
    page.getByRole("navigation", { name: "Location tree" })
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "Location tree" })
    .getByRole("button", { name: binder, exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: binder, exact: true })
  ).toBeVisible();
  await page.getByRole("button", { name: "New child" }).click();
  await expect(
    page.getByRole("heading", { name: "New Location" })
  ).toBeVisible();
  await pool.end();
});
