import { test, expect, type Page } from "@playwright/test";
import { fakeSignIn, signInAsOwner } from "./support/sign-in";

// Every failure lands on /sign-in with an `error` code; the page shows one allowlisted message, announces and focuses
// it once, keeps the sign-in links right below it, and removes the code from the address bar. The refusals here are
// real ones from the gateway through the OAuth test fake on an owner-only stack; codes no stack can produce yet
// (too many attempts, unknown codes) are opened directly.
const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";

async function expectMessage(page: Page, text: string, next?: string) {
  const alert = page.getByRole("alert");
  await expect(alert).toContainText(text);
  if (next) await expect(alert).toContainText(next);
  await expect(alert).toBeFocused();
  await expect(page).toHaveURL(`${ORIGIN}/sign-in`);
  await expect(
    page.getByRole("link", { name: "Sign in with Google" })
  ).toBeVisible();
}

test("a cancelled consent says so and offers the sign-in links again", async ({
  page,
}) => {
  await fakeSignIn(page, { identity: "cancel", provider: "discord" });
  await expectMessage(page, "Sign-in was cancelled.");
});

test("an unverified or missing provider email names the provider used", async ({
  page,
}) => {
  await fakeSignIn(page, { identity: "unverified", provider: "google" });
  await expectMessage(
    page,
    "Your Google account needs a verified email address.",
    "Verify it with Google"
  );
  await fakeSignIn(page, { identity: "no-email", provider: "discord" });
  await expectMessage(
    page,
    "Your Discord account needs a verified email address.",
    "Verify it with Discord"
  );
});

test("a new collector on an owner-only deployment is told it isn't open yet", async ({
  page,
}) => {
  await fakeSignIn(page, { identity: "newcomer" });
  await expectMessage(page, "PrizeCheck isn't open for new sign-ins yet.");
  await page.goto(`${ORIGIN}/sign-in?error=signup_disabled`);
  await expectMessage(page, "PrizeCheck isn't open for new sign-ins yet.");
});

test("too many attempts, unknown codes and Sign-ins-only codes get their fixed messages", async ({
  page,
}) => {
  await page.goto(`${ORIGIN}/sign-in?provider=google&error=too_many_sign_ups`);
  await expectMessage(page, "Too many sign-ins right now. Try again later.");
  for (const code of [
    "made_up_code",
    "account_not_linked",
    "state_mismatch",
    "account_already_linked_to_different_user",
  ]) {
    await page.goto(`${ORIGIN}/sign-in?error=${code}`);
    await expectMessage(page, "Sign-in didn't complete.", "Try again.");
  }
});

test("free text from the address is never shown", async ({ page }) => {
  await page.goto(
    `${ORIGIN}/sign-in?provider=Evil%20Corp&error=email_not_verified&error_description=INJECTED-DESCRIPTION`
  );
  await expectMessage(
    page,
    "Your sign-in account needs a verified email address."
  );
  await expect(page.locator("body")).not.toContainText("INJECTED-DESCRIPTION");
  await expect(page.locator("body")).not.toContainText("Evil Corp");
});

test("a signed-in collector never sees a failure code, and it leaves the address bar", async ({
  page,
}) => {
  await signInAsOwner(page, "/workspace");
  await page.goto(
    `${ORIGIN}/workspace?provider=google&error=access_denied&error_description=INJECTED`
  );
  await expect(page).toHaveURL(`${ORIGIN}/workspace`);
  await expect(
    page.getByRole("button", { name: "Sign out" }).first()
  ).toBeVisible();
  await expect(page.getByText("Sign-in was cancelled.")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("INJECTED");
});

test("the message takes focus once and the sign-in links are the next stop", async ({
  page,
}) => {
  await page.goto(`${ORIGIN}/sign-in?error=access_denied`);
  await expect(page.getByRole("alert")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("link", { name: "Sign in with Google" })
  ).toBeFocused();
  await page.reload();
  await expect(page.getByRole("alert")).toHaveCount(0);
});
