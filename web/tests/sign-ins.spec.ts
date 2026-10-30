import { test, expect, type Page } from "@playwright/test";
import { Pool } from "pg";
import { signInAsOwner } from "./support/sign-in";

// The Settings page's Sign-ins section (#156; part of Settings since #207) on an owner-only stack, through the OAuth
// test fake: the list, connecting and removing a sign-in, Remove hidden for the last one, a sign-in that belongs to
// another collector, the stale-session path, and the way in from the avatar menu on desktop and from the More sheet on
// a phone. The gateway still returns link starts to the old /settings/sign-ins, which the app rewrites to /settings.
// Stacks are shared between specs, so every test starts by leaving the owner with only their Google sign-in.
const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";
const OWNER_EMAIL = process.env.OWNER_EMAIL || "owner@example.test";
const OTHER = "sign-ins-spec-other-collector";
// The fake's newcomer identity's Discord account id (auth/testing/oauth-fake/core.ts).
const NEWCOMER_DISCORD = "100000000000000003";

let pool: Pool;
test.beforeAll(() => {
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
});
test.afterAll(async () => {
  await pool.end();
});
test.beforeEach(async () => {
  await pool.query(
    `DELETE FROM account WHERE "providerId"<>'google' AND "userId" IN (SELECT id FROM "user" WHERE email=$1)`,
    [OWNER_EMAIL]
  );
  await pool.query('DELETE FROM "user" WHERE id=$1', [OTHER]);
});

/** The fake consent page picks this identity for the next provider step (the page's links carry none). */
async function chooseIdentity(page: Page, identity: string) {
  await page
    .context()
    .addCookies([
      { name: "fake_oauth_identity", value: identity, url: ORIGIN },
    ]);
}
const signIns = (page: Page) =>
  page.getByRole("region", { name: "Your sign-ins" });
const row = (page: Page, provider: string) =>
  signIns(page).getByRole("listitem").filter({ hasText: provider });

test("lists, connects and removes sign-ins, never offering to remove the last", async ({
  page,
}) => {
  await signInAsOwner(page, "/collection");
  await page.getByRole("button", { name: "Account" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await expect(page).toHaveURL(`${ORIGIN}/settings`);
  await expect(page.getByRole("heading", { name: "Sign-ins" })).toBeVisible();
  await expect(signIns(page)).toContainText(
    `Your account email: ${OWNER_EMAIL}`
  );
  await expect(row(page, "Google")).toContainText("Connected");
  await expect(
    signIns(page).getByRole("button", { name: /^Remove/ })
  ).toHaveCount(0);
  // A different verified email may be connected deliberately.
  await chooseIdentity(page, "different-email");
  await signIns(page).getByRole("link", { name: "Connect Discord" }).click();
  await expect(row(page, "Discord")).toContainText("Connected", {
    timeout: 15_000,
  });
  await expect(page).toHaveURL(`${ORIGIN}/settings`);
  await expect(
    signIns(page).getByRole("button", { name: "Remove Google" })
  ).toBeVisible();
  await signIns(page).getByRole("button", { name: "Remove Discord" }).click();
  await expect(signIns(page).getByRole("status")).toHaveText(
    "Discord sign-in removed."
  );
  await expect(
    signIns(page).getByRole("link", { name: "Connect Discord" })
  ).toBeVisible();
  await expect(
    signIns(page).getByRole("button", { name: /^Remove/ })
  ).toHaveCount(0);
});

test("refuses a sign-in another collector holds, without naming them", async ({
  page,
}) => {
  await pool.query(
    `INSERT INTO "user"(id, name, email, "emailVerified") VALUES ($1, 'Other', 'sign-ins-spec-other@example.test', true)`,
    [OTHER]
  );
  await pool.query(
    `INSERT INTO account(id, "accountId", "providerId", "userId", "updatedAt") VALUES ($1, $2, 'discord', $3, now())`,
    [`${OTHER}-discord`, NEWCOMER_DISCORD, OTHER]
  );
  try {
    await signInAsOwner(page, "/settings");
    await chooseIdentity(page, "newcomer");
    await signIns(page).getByRole("link", { name: "Connect Discord" }).click();
    const alert = page
      .getByRole("alert")
      .filter({ hasText: "already connected" });
    await expect(alert).toContainText(
      "That Discord sign-in is already connected to a different PrizeCheck account.",
      { timeout: 15_000 }
    );
    await expect(alert).toBeFocused();
    await expect(page).toHaveURL(`${ORIGIN}/settings`);
    await expect(page.locator("#main-content")).not.toContainText(
      "sign-ins-spec-other"
    );
    await expect(page.locator("#main-content")).not.toContainText("newcomer");
    await expect(
      row(page, "Discord").getByRole("link", { name: "Connect Discord" })
    ).toBeVisible();
    // Back to Sign-ins dismisses the message and moves focus to the Sign-ins section's heading, not the page body.
    await alert.getByRole("button", { name: "Back to Sign-ins" }).click();
    await expect(alert).toHaveCount(0);
    await expect(
      page.getByRole("heading", { level: 2, name: "Sign-ins" })
    ).toBeFocused();
    // Signing out afterwards shows the sign-in page without replaying the link failure.
    await page.getByRole("button", { name: "Account" }).click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await expect(
      page.getByRole("link", { name: "Continue with Google" })
    ).toBeVisible();
    await expect(
      page.getByRole("alert").filter({ hasText: /connected|complete/ })
    ).toHaveCount(0);
  } finally {
    await pool.query('DELETE FROM "user" WHERE id=$1', [OTHER]);
  }
});

test("asks a stale session to sign in again, then returns to Settings", async ({
  page,
}) => {
  await signInAsOwner(page, "/settings");
  await pool.query(
    `UPDATE session SET "createdAt"=now()-interval '25 hours' WHERE "userId" IN (SELECT id FROM "user" WHERE email=$1)`,
    [OWNER_EMAIL]
  );
  await signIns(page).getByRole("link", { name: "Connect Discord" }).click();
  const alert = page.getByRole("alert").filter({ hasText: "sign in again" });
  await expect(alert).toContainText(
    "For your security, sign in again to change your sign-ins.",
    { timeout: 15_000 }
  );
  await expect(alert).toBeFocused();
  await expect(page).toHaveURL(`${ORIGIN}/settings`);
  await alert.getByRole("button", { name: "Sign in again" }).click();
  await expect(page).toHaveURL(`${ORIGIN}/sign-in?next=%2Fsettings`);
  await chooseIdentity(page, "owner");
  await page.getByRole("link", { name: "Continue with Google" }).click();
  await expect(page).toHaveURL(`${ORIGIN}/settings`, {
    timeout: 15_000,
  });
  await expect(row(page, "Google")).toContainText("Connected");
});

test("reaches Sign-ins in Settings from the account sheet on a phone", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signInAsOwner(page, "/collection");
  await page.getByRole("button", { name: "Account", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Account" })
    .getByRole("button", { name: "Settings" })
    .click();
  await expect(page).toHaveURL(`${ORIGIN}/settings`);
  await expect(row(page, "Google")).toContainText("Connected");
});
