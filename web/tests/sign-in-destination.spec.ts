import { test, expect, type Page } from "@playwright/test";

// The web-side safeDestination() guard: whatever `next` says, an email-code sign-in only ever lands on this origin.
// Mocked /auth/** in the review-fixes.spec.ts style, because the stacks run with email codes off.
const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";

async function mockEmailSignIn(page: Page) {
  let signedIn = false;
  await page.route("**/auth/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/auth/methods")
      return route.fulfill({ json: { providers: [], emailSignIn: true } });
    if (path === "/auth/request-code")
      return route.fulfill({ status: 202, json: {} });
    if (path === "/auth/verify-code") {
      signedIn = true;
      return route.fulfill({ status: 200, json: {} });
    }
    if (path === "/auth/session")
      return route.fulfill({
        json: { signedIn, userId: signedIn ? "owner" : null },
      });
    return route.fulfill({ json: {} });
  });
  await page.route("**/api/**", (route) =>
    route.fulfill({
      status: new URL(route.request().url()).pathname.startsWith("/api/admin")
        ? 403
        : 200,
      json: { locations: [], nodes: [], owner_revision: 1 },
    })
  );
}

async function signInByCode(page: Page) {
  await page.getByLabel("Email", { exact: true }).fill("owner@example.test");
  await page.getByRole("button", { name: "Send code", exact: true }).click();
  await page.getByLabel("Six-digit code").fill("123456");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

// The positive control: a safe next is followed, even from a page that would otherwise land on /workspace.
test("sign-in follows a safe next to /collection", async ({ page }) => {
  await mockEmailSignIn(page);
  await page.goto(`${ORIGIN}/locations?next=%2Fcollection`);
  await signInByCode(page);
  await expect(page).toHaveURL(`${ORIGIN}/collection`);
});

// Each rejection starts on /collection, so landing on /workspace proves next was read and refused, not ignored.
for (const [name, next] of [
  ["an absolute URL on another origin", "https%3A%2F%2Fexample.com%2Fsteal"],
  ["a protocol-relative URL", "%2F%2Fevil.example"],
  ["a path containing a backslash", "%2F%5Cevil.example"],
] as const) {
  test(`sign-in ignores ${name} in next and lands on /workspace`, async ({
    page,
  }) => {
    await mockEmailSignIn(page);
    await page.goto(`${ORIGIN}/collection?next=${next}`);
    await signInByCode(page);
    await expect(page).toHaveURL(`${ORIGIN}/workspace`);
  });
}
