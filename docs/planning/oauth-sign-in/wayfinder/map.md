# OAuth sign-in — decision map

**Label:** wayfinder:map

**Status:** charted 2026-10-12; every ticket resolved 2026-10-12. The way is clear. Spec published as [Spec: OAuth sign-in with Google and Discord](https://github.com/ry-cen/prizecheck/issues/147) ([spec.md](../spec.md)). Implementation tickets published (listed in the spec).

## Destination

An agreed plan, spec published as [Spec: OAuth sign-in with Google and Discord](https://github.com/ry-cen/prizecheck/issues/147) ([spec.md](../spec.md)). Implementation tickets published (listed in the spec).and `/to-ticket`, that makes Google and Discord the sign-in methods collectors see, able to create accounts. Email-code sign-in stays built but switched off until it's ready. Owner approval codes and operations mail are unchanged. This effort resolves decisions only. The spec at `docs/planning/oauth-sign-in/spec.md`, the implementation tickets and the code come after this map.

## Notes

- Owner request on 2026-10-12: add OAuth sign-in for the backend, starting with Discord and Google.
- **Additive.** Email codes are not removed. Email-code sign-in is turned off by an operator switch that the endpoint enforces, not only hidden in the UI, until the owner decides it's ready. Owner approval codes (`/auth/approval-code`) and operations alerts keep using mail.
- **OAuth creates accounts** under the same `SIGNUP_MODE` gate as today. Owner-only stays the default, and public signup opens only on an OAuth-appropriate readiness proof.
- **The owner moves over by email match.** The owner will sign in with Google and Discord accounts that use the same address as `OWNER_EMAIL`, and those sign-ins must reach the existing account and its data.
- **Adding a provider stays cheap.** Linking, gating and profile rules must not depend on which provider is used. A third provider should take configuration plus credentials, not new decisions.
- **Provider credentials are launch work, not a decision.** The spec carries the owner's Google and Discord console checklist. Redirect URIs are exactly `${PUBLIC_ORIGIN}/api/auth/callback/<id>`.
- **Sign-in screen.** This map decides which sign-in buttons exist and how they behave. Their layout belongs to the app-redesign map's "Sign-in and loading screens" fog.
- Current stack: Better Auth 1.7.6 installed (`package.json` pins `^1.4.0`) in `auth/` behind the same-origin gateway (`auth/src/server.ts`), with email OTP only and passwords off. The owner-only gate is enforced in the gateway by checking the email on OTP requests, so an OAuth callback needs its own gate. Better Auth's `account` table already exists (`migrations/002_auth.sql`). Several linking and gating options exist only in Better Auth 1.7, so if the spec relies on them it must raise the `^1.4.0` floor.
- **The owner hands technical auth choices to Claude** (2026-10-12). Take the security-sound recommendation, record it, and bring the owner only owner-facing decisions: when public signup opens, what collectors see, account-settings scope, and console work only the owner can do.
- Use grilling and domain-modeling for decision tickets and research for research tickets. Use `CONTEXT.md` vocabulary and record new terms there as they're resolved. Consult Laya before delegation. Commit and push only with owner approval; stage explicit paths.
- Tickets are GitHub Issues labelled `wayfinder` and `feature: oauth sign-in`, blocked with GitHub's native dependencies and a "Blocked by" body line. Research and resolutions live beside this map. Work goes on `feature/oauth-sign-in`, cut from `dev`.

## Decisions so far

<!-- One line per closed ticket: link plus a one-line gist. -->

- [Research running OAuth sign-in locally and in CI](https://github.com/ry-cen/prizecheck/issues/130): No mock server can replace the built-in providers through config. The lean is real providers, with msw faking their server side (launcher-only) and Playwright faking the consent page. The fake stays outside `auth/src` with loopback-only overrides, because a `NODE_ENV` guard isn't enough. [Research](research/oauth-local-and-ci.md)
- [Research Google and Discord sign-in under Better Auth](https://github.com/ry-cen/prizecheck/issues/129): Accounts are keyed by the provider's stable id. Linking by email happens automatically, and only when both the provider and the local row are verified. Discord email can be null or unverified. `validateUserInfo` is the one provider-agnostic gate for create, link and sign-in. Unsorted needs no change. Tokens are stored unless a hook nulls them. Public signup's mail proof must change. [Research](research/google-discord-better-auth.md)
- [Decide how a sign-in links to an existing account](https://github.com/ry-cen/prizecheck/issues/131): A sign-in links by email only when the provider and the existing account both have it verified, with no trusted providers. Unverified or missing emails are refused before anything is created. Returning sign-ins match on the provider's account id, and the owner moves over by the same rule. The spec raises Better Auth to 1.7. [Resolution](resolutions/decide-sign-in-linking.md)
- [Decide how the gateway exposes OAuth sign-in routes](https://github.com/ry-cen/prizecheck/issues/135): Two explicit gateway routes, a `GET /auth/sign-in/:provider?next=` start and the `/api/auth/callback/:provider` callback, for any configured provider. Every other `/api/auth/*` path returns 404. Errors land on the sign-in page, and `next` must be a checked same-origin path (default `/collection`). [Resolution](resolutions/decide-gateway-oauth-routes.md)
- [Decide the gates for OAuth signup and hidden email sign-in](https://github.com/ry-cen/prizecheck/issues/132): One provider-agnostic `validateUserInfo` gate covers create, link and sign-in under `SIGNUP_MODE`. `EMAIL_SIGN_IN=off` by default, enforced at the gateway and in Better Auth, with approval codes unaffected. Readiness proof version 2 replaces the mail checks with real sign-in for every configured provider (owner's launch bar, no brand verification). `GET /auth/methods` drives the sign-in buttons. [Resolution](resolutions/decide-signup-and-email-gates.md)
- [Decide which provider profile data to keep](https://github.com/ry-cen/prizecheck/issues/133): Only the provider account id, display name and picture URL are kept, shown privately in the signed-in app (owner's choice). Name and picture follow the latest sign-in or link, and the fallback is the email's initial. Provider tokens are never stored. [Resolution](resolutions/decide-provider-profile-data.md)
- [Decide how local dev and CI fake provider sign-in](https://github.com/ry-cen/prizecheck/issues/134): The real provider code runs, with provider HTTP faked in-process by a launcher-only module that fails closed, and a fake consent page served on our own start route (the prototype showed Playwright can't intercept the provider redirect). It's kept out of production by three guards. [Resolution](resolutions/decide-oauth-test-fake.md)
- [Decide how the sign-in settings page behaves](https://github.com/ry-cen/prizecheck/issues/143): `/settings/sign-ins` lists every configured provider and links or unlinks through three gateway routes. Deliberate links may use a different, verified email. Accounts owned by another collector are refused, the last sign-in can't be removed, and changes need a sign-in within 24 hours. The scope is the owner's. [Resolution](resolutions/decide-sign-in-settings-page.md)
- [Decide what the sign-in page says when sign-in fails](https://github.com/ry-cen/prizecheck/issues/144): A provider-neutral allowlist of seven message groups, with unknown codes shown as "Didn't complete". Provider error text is never displayed, and no message reveals whether an account exists. The exact wording goes to the app-redesign sign-in screen. [Resolution](resolutions/decide-sign-in-failure-messages.md)
- [Decide limits on OAuth account creation](https://github.com/ry-cen/prizecheck/issues/145): Only creation is limited: 10 per trusted IP per day, plus a `DAILY_SIGNUP_CAP` (default 100) app-wide. Both are checked in the gate under an advisory lock, with the IP passed from the gateway. There's also a 60-per-hour start limit per IP, and the owner panel warns at 80%. [Resolution](resolutions/decide-oauth-signup-limits.md)

## Not yet specified

_Nothing left in the fog. Every remaining question is a live ticket._

## Out of scope

- Apple, GitHub and other providers. Adding one later must stay cheap (see Notes).
- Passwords.
- Removing email-code sign-in or owner approval codes.
- Changing how operations mail works.
- Changing session length or cookie rules.
- The sign-in screen's visual layout, owned by the app-redesign map.
