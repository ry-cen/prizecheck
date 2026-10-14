import { test, expect } from "@playwright/test";
import { signInAsOwner } from "./support/sign-in";

// The gate's stacks run like a deployment after #153: providers configured (the fake's placeholder credentials) and
// email-code sign-in off.
const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";

test("offers only the configured providers and no email form when email sign-in is off", async ({
  page,
}) => {
  await page.goto(`${ORIGIN}/collection`);
  await expect(
    page.getByRole("link", { name: "Continue with Google" })
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Continue with Discord" })
  ).toBeVisible();
  await expect(page.getByLabel("Email")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Email me a code" })
  ).toHaveCount(0);
});

test("signs the owner in through the fake consent page and returns to the page asked for", async ({
  page,
}) => {
  await signInAsOwner(page, "/decks");
  await expect(
    page.getByRole("navigation", { name: "Main views" })
  ).toBeVisible();
});

test("answers 404 on the email-code routes", async ({ request }) => {
  for (const path of ["/auth/request-code", "/auth/verify-code"]) {
    const response = await request.post(`${ORIGIN}${path}`, {
      headers: { origin: ORIGIN },
      data: { email: process.env.OWNER_EMAIL || "owner@example.test" },
    });
    expect(response.status(), path).toBe(404);
  }
});
