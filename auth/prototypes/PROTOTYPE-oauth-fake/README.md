# PROTOTYPE: faking Google and Discord sign-in (throwaway)

This answers [Decide how local dev and CI fake provider sign-in](https://github.com/ry-cen/prizecheck/issues/134). Run it with `node auth/prototypes/PROTOTYPE-oauth-fake/run.mjs`. It uses an in-memory database, a stand-in for the gateway's two OAuth routes, and headless Chromium. It never contacts Google or Discord.

## What it showed (2026-10-12, Better Auth 1.7.6, Playwright from the repo)

| Sign-in | Result |
|---|---|
| Google as owner | Created the owner, landed on `/done` |
| Discord as owner (same verified email) | **Linked** to the same user, landed on `/done` |
| Discord as a new collector | Created a second user |
| Google with an unverified email | Refused with `email_not_verified` by `validateUserInfo`. No row created. |

The real `google()` and `discord()` provider code ran, including Google's PKCE `code_verifier` and Discord's `BigInt(id)` avatar path. Only the HTTP calls to the providers were faked.

## Findings

1. **A Playwright route on the provider's domain never fires.** Playwright routes only the first request of a redirect chain, so our `302` to accounts.google.com isn't intercepted, and the browser loaded Google's real sign-in page. The fix is to route our own start URL `/auth/sign-in/*`, fetch it without following redirects, and answer the provider hop ourselves.
2. **Chromium doesn't follow a `302` returned by `route.fulfill` for a navigation.** The fix is to serve a tiny fake consent page, with Better Auth's `state` cookie, that forwards to the real callback with a fake `code` naming the test identity.
3. **Better Auth URL-encodes Discord's `/users/@me` as `/users/%40me`.** A fake that compares raw paths misses it, and the call goes to the real Discord. The fake must decode paths and **fail closed** on any provider-host request it doesn't recognise.
4. **An unsigned Google ID token is accepted on the callback.** The fake ID token needs only plausible claims.
5. **Linking and the creation gate behaved exactly as decided.** Linking by verified email works across providers, and `validateUserInfo` refuses before any row is written.

The fetch interception here patches `globalThis.fetch` by hand. msw does the same thing with less code, and either works.
