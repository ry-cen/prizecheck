import { expect, type Page } from "@playwright/test";
import { Pool } from "pg";

// Browser journeys sign in through the OAuth test fake (auth/testing/oauth-fake), which the gate loads into every stack's
// gateway: the start route redirects to the fake consent page, which forwards to the real callback with the chosen
// test identity. Email codes are off on the stacks.

/** Any request to a real provider host is aborted, so no journey ever reaches Google or Discord. */
const PROVIDER_HOSTS =
  /^https?:\/\/([^/?#]*\.)?(google\.com|googleapis\.com|googleusercontent\.com|discord\.com|discordapp\.com)(:\d+)?([/?#]|$)/;

export type FakeSignIn = {
  /** A fake identity (auth/testing/oauth-fake/core.ts) or `cancel`. Default `owner`. */
  identity?: string;
  provider?: "google" | "discord";
  /** Passed to the start route as `next`; the gateway checks it. */
  next?: string;
};

function origin(): string {
  return process.env.TEST_ORIGIN || "http://localhost:5173";
}

/**
 * Clears the sign-in rate limits and blocks real provider hosts. Every journey signs in from one loopback address,
 * which would soon pass the sign-in start limit (60 per hour) and, on a public stack, the creation limits: clear them
 * first, as the email journeys cleared auth_send_event.
 */
async function prepareFakeSignIn(page: Page) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query("DELETE FROM auth_rate_event");
  } finally {
    await pool.end();
  }
  await page.context().route(PROVIDER_HOSTS, (route) => route.abort());
}

/** Walks start, fake consent and callback in the browser; resolves once the browser has left the fake. */
export async function fakeSignIn(
  page: Page,
  { identity = "owner", provider = "google", next }: FakeSignIn = {}
): Promise<void> {
  await prepareFakeSignIn(page);
  const start = new URL(`/auth/sign-in/${provider}`, origin());
  if (next) start.searchParams.set("next", next);
  start.searchParams.set("fake_identity", identity);
  await page.goto(start.href, { waitUntil: "commit" });
  await page.waitForURL(
    (url) =>
      url.pathname !== "/auth/__fake-oauth/consent" &&
      !url.pathname.startsWith("/api/auth/") &&
      !url.pathname.startsWith("/auth/")
  );
}

/** The old Collection addresses the app rewrites to /collection (web/src/shell/routes.ts canonicalPath). */
const OLD_COLLECTION_PATHS = [
  "/",
  "/workspace",
  "/locations",
  "/old-collection",
];

/** Where the app shows `next`: an old Collection address is rewritten to /collection, keeping the query. */
function landing(next: string): string {
  const url = new URL(next, origin());
  if (OLD_COLLECTION_PATHS.includes(url.pathname)) url.pathname = "/collection";
  return url.href;
}

/** Signs in as the owner at OWNER_EMAIL and waits for `next` (default /collection) to load. */
export async function signInAsOwner(page: Page, next = "/collection") {
  await fakeSignIn(page, { next });
  await expect(page).toHaveURL(landing(next));
}

/**
 * Signs in from the sign-in card already on screen, through its "Continue with …" button, as a fake identity (default
 * the owner), and waits for the signed-in shell. The fake consent page reads the identity from a cookie, because the
 * button carries none.
 */
export async function signInWithButton(
  page: Page,
  {
    identity = "owner",
    provider = "Google",
    tap = false,
  }: { identity?: string; provider?: "Google" | "Discord"; tap?: boolean } = {}
): Promise<void> {
  await prepareFakeSignIn(page);
  await page
    .context()
    .addCookies([
      { name: "fake_oauth_identity", value: identity, url: origin() },
    ]);
  const button = page.getByRole("link", { name: `Continue with ${provider}` });
  await (tap ? button.tap() : button.click());
  await expect(
    page.getByRole("navigation", { name: "Main views" })
  ).toBeVisible({ timeout: 15_000 });
}
