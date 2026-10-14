import { test, expect } from "@playwright/test";
import { Pool } from "pg";
import { signInAsOwner } from "./support/sign-in";

// The signed-in collector sees their provider picture, or the first letter of their email, as the avatar, and their
// provider name above the email in the avatar menu. The test helper aborts every request to a provider host, so the
// picture itself never loads here and the letter stands in for it.
const OWNER_EMAIL = process.env.OWNER_EMAIL || "owner@example.test";

test("shows the owner's provider name, with the first letter of the email when the picture can't load", async ({
  page,
}) => {
  await signInAsOwner(page, "/collection");
  const avatar = page.getByRole("button", { name: "Account" });
  await expect(avatar.getByTestId("profile-initial")).toHaveText(
    OWNER_EMAIL.charAt(0).toUpperCase()
  );
  await avatar.click();
  await expect(
    page.getByText("Owner Collector", { exact: true })
  ).toBeVisible();
  await expect(page.getByText(OWNER_EMAIL, { exact: true })).toBeVisible();
});

test("shows only the first letter of the email when there is no name or picture", async ({
  page,
}) => {
  await signInAsOwner(page, "/collection");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query(`UPDATE "user" SET name='', image=NULL WHERE email=$1`, [
      OWNER_EMAIL,
    ]);
    await page.reload();
    const avatar = page.getByRole("button", { name: "Account" });
    await expect(avatar.getByTestId("profile-initial")).toHaveText(
      OWNER_EMAIL.charAt(0).toUpperCase()
    );
    await avatar.click();
    await expect(page.getByText(OWNER_EMAIL, { exact: true })).toBeVisible();
    await expect(page.getByText("Owner Collector")).toHaveCount(0);
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
  await signInAsOwner(page, "/collection");
  await page.route(/^https:\/\/lh3\.googleusercontent\.com\//, (route) =>
    route.fulfill({ contentType: "image/png", body: PIXEL })
  );
  await page.reload();
  const account = page.getByRole("button", { name: "Account" });
  const avatar = account.getByTestId("profile-picture");
  await expect(avatar).toBeVisible();
  await expect(avatar).toHaveAttribute(
    "src",
    "https://lh3.googleusercontent.com/a/fake-owner"
  );
  await expect(avatar).toHaveAttribute("referrerpolicy", "no-referrer");
  await expect(account.getByTestId("profile-initial")).toHaveCount(0);
});
