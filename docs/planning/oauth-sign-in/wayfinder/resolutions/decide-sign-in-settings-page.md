# Decide how the sign-in settings page behaves

Resolved 2026-10-12 for [Decide how the sign-in settings page behaves](https://github.com/ry-cen/prizecheck/issues/143). The owner set the scope: see linked sign-ins, link another (a different email allowed), unlink but never the last, with no profile editing and no account deletion. The behaviour below is technical, delegated to Claude. Facts come from `api/routes/account.mjs`, `oauth2/link-account.mjs` and `context/create-context.mjs` in the installed Better Auth 1.7.6.

## Decisions

1. **Place: "Sign-ins" in the avatar menu on desktop and the More sheet on mobile, at `/settings/sign-ins`.** It sits beside Owner controls and Sign out, from the app-redesign shell decision. Its visual layout belongs to the app-redesign map.
2. **The page lists every configured provider** from `GET /auth/methods`. For each one it shows the linked sign-in, if any, with the date linked, or a "Connect" button. A new provider appears with no page change. Provider account ids and emails aren't shown. The collector's own email is shown once at the top.
3. **Three gateway routes**, following the gateway decision's rules: explicit routes, any configured provider, checked destinations.
   - `GET /auth/sign-ins` lists the signed-in collector's linked providers, using Better Auth's list-accounts.
   - `GET /auth/link/:provider` starts Better Auth's link-social and returns to `/settings/sign-ins` through the same callback route, `/api/auth/callback/:provider`.
   - `POST /auth/unlink/:provider` checks the origin, then uses the dedicated sign-in removal module.
4. **A different email is allowed when linking deliberately** (`allowDifferentEmails: true`). It only affects linking from inside a signed-in session. Automatic linking at sign-in still matches only the same verified email.
5. **Deliberate linking still requires a verified provider email.** `validateUserInfo` runs for linking too, so the one rule from [Decide how a sign-in links to an existing account](https://github.com/ry-cen/prizecheck/issues/131) holds everywhere.
6. **A provider account already linked to another collector is refused.** Better Auth returns `account_already_linked_to_different_user`, and the page says that sign-in belongs to a different PrizeCheck account. It never moves an account between collectors, and it doesn't reveal which collector holds it.
7. **The last sign-in can't be removed.** The removal module applies the configured-provider rule while holding one collector's row lock, so concurrent removals serialize: the lock winner can succeed and the other request re-reads state before receiving the existing last-sign-in refusal. The page still hides Remove when only one is linked. Email-code sign-in isn't counted as a sign-in method here. Even when it's on, a collector keeps at least one provider.
8. **Changing sign-ins needs a recent sign-in.** Linking and unlinking both need a session signed in within Better Auth's `freshAge`, which defaults to 24 hours. Better Auth verifies the initial cookie session; the removal module re-reads the persisted session and evaluates freshness after waiting for its collector lock. The gateway enforces the same comparison for its link start. Otherwise the page asks the collector to sign in again and brings them back to `/settings/sign-ins`. This stops a stolen, long-lived session from quietly attaching an attacker's account.

## Consequences for the spec

- The routes need tests for:
  - unknown providers;
  - a stale session (link and unlink);
  - linking an account owned by someone else;
  - linking an unverified email;
  - a different but verified email;
  - unlinking the last provider;
  - the origin check on unlink.
- Better Auth's `/api/auth/link-social`, `/unlink-account` and `/list-accounts` stay unreachable from outside. The gateway still calls its internal link and list endpoints; removal does not call `unlink-account`.
- Every message on this page follows [Decide what the sign-in page says when sign-in fails](https://github.com/ry-cen/prizecheck/issues/144).

## Technical amendment (2026-10-26)

The accepted concurrency and atomicity correction supersedes the historical per-account Better Auth `unlink-account` calls, without changing the owner's page decisions or public responses. The dedicated sign-in removal module is the seam for removal: it uses a bounded PostgreSQL pool and one transaction per request, locks the collector row, re-reads the authoritative session, freshness, and configured-provider state after any wait, then issues one provider-wide delete and commits. A pre-commit failure rolls back every selected-provider row. A lost commit acknowledgement leaves the client outcome uncertain; the gateway does not retry automatically. Better Auth remains the initial-cookie verifier, and its internal link, list, and unlink endpoints remain externally blocked.
