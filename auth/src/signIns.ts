// The gateway's rules for the Sign-ins settings page (OAuth spec #147, ticket #156): what a collector sees of their
// linked sign-ins, when a session may change them, what removing one does, and which link starts come from another
// site. The routes in server.ts apply them. Better Auth's own link, unlink and list endpoints stay unreachable.

/** The web Sign-ins page. Link starts return here, with `?provider=<id>&error=<code>` on a failure. */
export const SIGN_INS_PAGE = "/settings/sign-ins";

/**
 * A session may change sign-ins for 24 hours after it was created: Better Auth's default session.freshAge (auth.ts
 * doesn't set it), which Better Auth itself applies to unlinking. A rolling session keeps its creation time, so an
 * active session still goes stale.
 */
export const FRESH_AGE_MS = 24 * 60 * 60 * 1000;

/** Better Auth's freshness rule: stale once `now - createdAt >= freshAge`. */
export function isFresh(createdAt: Date | string, now = Date.now()): boolean {
  const created = new Date(createdAt).getTime();
  return Number.isFinite(created) && now - created < FRESH_AGE_MS;
}

/**
 * Whether a link start may go ahead. A link start is a plain GET link carrying the session cookie, and SameSite=Lax
 * sends that cookie on a top-level navigation from another site. Current browsers label requests with Sec-Fetch-Site,
 * so only a click inside PrizeCheck (`same-origin`) or a typed or bookmarked address (`none`) may start one. This is
 * defence in depth on top of SameSite=Lax and the 24-hour freshness rule, not a complete guard:
 * - Browsers send the header only to secure origins (https, or localhost), so PUBLIC_ORIGIN must be https in production.
 * - Safari before 16.4 doesn't send it at all.
 * - A link opened from a native app arrives as `none`.
 * A request without the header is allowed: the walk helper in the tests sends none.
 */
export function sameSiteStart(
  headers: Record<string, string | string[] | undefined>
): boolean {
  const site = headers["sec-fetch-site"];
  return site === undefined || site === "same-origin" || site === "none";
}

/** A row of Better Auth's /list-accounts answer (only the fields used here). */
export type AccountRow = { id: string; providerId: string; createdAt: string };

export type LinkedSignIn = { provider: string; linkedAt: string };

/**
 * GET /auth/sign-ins: one entry per configured provider that has a linked account, dated by its earliest link, in the
 * configured order. There are no account ids, row ids or emails. A provider that is no longer configured isn't listed.
 */
export function linkedSignIns(
  accounts: AccountRow[],
  configured: readonly { id: string }[]
): LinkedSignIn[] {
  const earliest = new Map<string, number>();
  for (const account of accounts) {
    const at = new Date(account.createdAt).getTime();
    if (!Number.isFinite(at)) continue;
    const seen = earliest.get(account.providerId);
    if (seen === undefined || at < seen) earliest.set(account.providerId, at);
  }
  return configured
    .filter((provider) => earliest.has(provider.id))
    .map((provider) => ({
      provider: provider.id,
      linkedAt: new Date(earliest.get(provider.id)!).toISOString(),
    }));
}

export type UnlinkPlan =
  | { kind: "not-linked" }
  | { kind: "last" }
  | { kind: "unlink"; accountIds: string[] };

/**
 * POST /auth/unlink/:provider removes every account of that provider (a collector can hold two Google accounts at one
 * verified email), by Better Auth account row id. It is refused when no account of another configured provider would
 * remain: email-code sign-in doesn't count as a sign-in here, and neither does a provider that is no longer
 * configured. Better Auth's own last-account check stays as a second layer.
 */
export function unlinkPlan(
  accounts: AccountRow[],
  provider: string,
  configured: readonly { id: string }[]
): UnlinkPlan {
  const mine = accounts.filter((account) => account.providerId === provider);
  if (mine.length === 0) return { kind: "not-linked" };
  const another = accounts.some(
    (account) =>
      account.providerId !== provider &&
      configured.some((entry) => entry.id === account.providerId)
  );
  return another
    ? { kind: "unlink", accountIds: mine.map((account) => account.id) }
    : { kind: "last" };
}
