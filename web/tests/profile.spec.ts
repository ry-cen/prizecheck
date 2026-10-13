import { test, expect } from "@playwright/test";
import { Pool } from "pg";
import { signInAsOwner } from "./support/sign-in";

// The signed-in collector sees their provider name and picture, or the first letter of their email. The test helper
// aborts every request to a provider host, so the picture itself never loads here and the letter stands in for it.
const OWNER_EMAIL = process.env.OWNER_EMAIL || "owner@example.test";

test("shows the owner's provider name, with the first letter of the email when the picture can't load", async ({
  page,
}) => {
  await signInAsOwner(page, "/workspace");
  const nav = page.getByRole("navigation", { name: "Main views" }).first();
  await expect(nav.getByText("Owner Collector")).toBeVisible();
  await expect(nav.getByTestId("profile-initial")).toHaveText(
    OWNER_EMAIL.charAt(0).toUpperCase()
  );
});

test("shows only the first letter of the email when there is no name or picture", async ({
  page,
}) => {
  await signInAsOwner(page, "/workspace");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query(`UPDATE "user" SET name='', image=NULL WHERE email=$1`, [
      OWNER_EMAIL,
    ]);
    await page.reload();
    const nav = page.getByRole("navigation", { name: "Main views" }).first();
    await expect(nav.getByTestId("profile-initial")).toHaveText(
      OWNER_EMAIL.charAt(0).toUpperCase()
    );
    await expect(nav.getByText("Owner Collector")).toHaveCount(0);
  } finally {
    await pool.query(
      `UPDATE "user" SET name='Owner Collector', image='https://lh3.googleusercontent.com/a/fake-owner' WHERE email=$1`,
      [OWNER_EMAIL]
    );
    await pool.end();
  }
});

const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);

test("shows the provider picture, with no referrer, when it loads", async ({
  page,
}) => {
  await signInAsOwner(page, "/workspace");
  await page.route(/^https:\/\/lh3\.googleusercontent\.com\//, (route) =>
    route.fulfill({ contentType: "image/png", body: PIXEL })
  );
  await page.reload();
  const nav = page.getByRole("navigation", { name: "Main views" }).first();
  const avatar = nav.locator("img.profile-badge-avatar");
  await expect(avatar).toBeVisible();
  await expect(avatar).toHaveAttribute(
    "src",
    "https://lh3.googleusercontent.com/a/fake-owner"
  );
  await expect(avatar).toHaveAttribute("referrerpolicy", "no-referrer");
  await expect(nav.getByTestId("profile-initial")).toHaveCount(0);
});
