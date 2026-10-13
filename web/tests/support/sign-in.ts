import { expect, type Page } from "@playwright/test";

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

/** Walks start, fake consent and callback in the browser; resolves once the browser has left the fake. */
export async function fakeSignIn(
  page: Page,
  { identity = "owner", provider = "google", next }: FakeSignIn = {}
): Promise<void> {
  await page.context().route(PROVIDER_HOSTS, (route) => route.abort());
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

/** Signs in as the owner at OWNER_EMAIL and waits for `next` (default /workspace) to load. */
export async function signInAsOwner(page: Page, next = "/workspace") {
  await fakeSignIn(page, { next });
  await expect(page).toHaveURL(new URL(next, origin()).href);
}
