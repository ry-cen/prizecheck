import { test, expect, type Page } from "@playwright/test";

// The sign-in page draws its methods from GET /auth/methods. These tests answer that route themselves, so they cover
// the page's behaviour whatever credentials the stack has; the gateway's own answer is covered in auth/tests.
const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";
const GOOGLE = { id: "google", name: "Google" };
const DISCORD = { id: "discord", name: "Discord" };

async function methods(
  page: Page,
  body: { providers: { id: string; name: string }[]; emailSignIn: boolean }
) {
  await page.route("**/auth/methods", (route) =>
    route.fulfill({ json: body, headers: { "cache-control": "no-store" } })
  );
}

test("draws one plain link per configured provider, carrying the protected page as next", async ({
  page,
}) => {
  await methods(page, { providers: [GOOGLE, DISCORD], emailSignIn: true });
  await page.goto(`${ORIGIN}/decks`);
  await expect(
    page.getByRole("link", { name: "Continue with Google" })
  ).toHaveAttribute("href", "/auth/sign-in/google?next=%2Fdecks");
  await expect(
    page.getByRole("link", { name: "Continue with Discord" })
  ).toHaveAttribute("href", "/auth/sign-in/discord?next=%2Fdecks");
  await expect(page.getByRole("link", { name: /^Continue with / })).toHaveCount(
    2
  );
  await expect(page.getByLabel("Email")).toBeVisible();
});

test("sends no next without a destination and passes an explicit next through", async ({
  page,
}) => {
  await methods(page, { providers: [GOOGLE], emailSignIn: true });
  // The bare origin is Collection (the app rewrites it), so the link asks to return there.
  await page.goto(`${ORIGIN}/`);
  await expect(
    page.getByRole("link", { name: "Continue with Google" })
  ).toHaveAttribute("href", "/auth/sign-in/google?next=%2Fcollection");
  // A page that is not a protected view sends no next.
  await page.goto(`${ORIGIN}/sign-in`);
  await expect(
    page.getByRole("link", { name: "Continue with Google" })
  ).toHaveAttribute("href", "/auth/sign-in/google");
  await page.goto(
    `${ORIGIN}/workspace?next=${encodeURIComponent("/collection?set=base")}`
  );
  await expect(
    page.getByRole("link", { name: "Continue with Google" })
  ).toHaveAttribute(
    "href",
    `/auth/sign-in/google?next=${encodeURIComponent("/collection?set=base")}`
  );
});

test("shows only the methods that are available", async ({ page }) => {
  await methods(page, { providers: [DISCORD], emailSignIn: false });
  await page.goto(`${ORIGIN}/collection`);
  await expect(
    page.getByRole("link", { name: "Continue with Discord" })
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Continue with Google" })
  ).toHaveCount(0);
  await expect(page.getByLabel("Email")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send code" })).toHaveCount(0);
});

test("keeps the email form alone when no provider is configured", async ({
  page,
}) => {
  await methods(page, { providers: [], emailSignIn: true });
  await page.goto(`${ORIGIN}/collection`);
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.getByRole("link", { name: /^Continue with / })).toHaveCount(
    0
  );
});
