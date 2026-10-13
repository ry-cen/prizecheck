# Decide the gates for OAuth signup and hidden email sign-in

Resolved 2026-10-12 for [Decide the gates for OAuth signup and hidden email sign-in](https://github.com/ry-cen/prizecheck/issues/132). The owner decided the launch bar (decision 3). The rest is technical, delegated to Claude. Facts come from [Google and Discord sign-in under Better Auth](../research/google-discord-better-auth.md), section 5, and from `auth/src/server.ts`, `auth/src/signup.ts` and `compose.deploy.yml`.

## Today

`SIGNUP_MODE` (`owner-only` by default, `local-public` or `public`) is enforced only by the gateway's email-code routes. They refuse every email except `OWNER_EMAIL` unless signup is public, and that includes sign-in to existing non-owner accounts. Public mode needs a readiness proof whose gates include mail sender and delivery checks, plus `MAIL_MODE=http`. Owner approval codes don't use the email-OTP plugin. `/auth/approval-code` looks up the owner through `owner_binding` and sends with `deliverCode()` directly.

## Decisions

1. **One gate for every sign-in method: Better Auth's `user.validateUserInfo`.** It runs before Better Auth creates a user, links a provider account or signs someone in, for OAuth and email codes alike, and it fails closed. It reads `SIGNUP_MODE` once at startup, as today, and never checks which provider is being used.
   - **Every mode:** refuse to create a user or link an account unless the provider vouches for the email (from [Decide how a sign-in links to an existing account](https://github.com/ry-cen/prizecheck/issues/131)).
   - **`owner-only`:**
     - Allow signing in or linking only when the existing user is the `owner_binding` user.
     - Allow creating a user only when the verified email is `OWNER_EMAIL`, for a fresh deployment with no owner account yet.
     - Refuse everything else with one error code, which says nothing about whether an account exists.
   - **`public` and `local-public`:** allow creating users, linking (by the linking rules) and signing in.
   - The gateway's current email checks stay as a second layer.
2. **The email sign-in switch: `EMAIL_SIGN_IN=off|on`, `off` by default everywhere.** Off means:
   - The gateway's `/auth/request-code` and `/auth/verify-code` return 404.
   - Better Auth's `disabledPaths` lists the email-OTP send and sign-in endpoints, so the plugin refuses them even internally. (The gateway already 404s every unlisted `/api/auth/*` path, from [Decide how the gateway exposes OAuth sign-in routes](https://github.com/ry-cen/prizecheck/issues/135).)
   - The sign-in page shows no email form.
   - Owner approval codes and operations mail keep working, because they never go through the plugin. They still need mail delivery configured, as today.
   - Turning email sign-in `on` with `NODE_ENV=production` refuses to start unless `MAIL_MODE=http`.
3. **Public signup's readiness proof becomes schema version 2.** Owner's decision.
   - **Always required:** `authorizedByOwner`, `ownerWalkthroughVerified`, `recoveryVerified`, `privacyVerified`, `capacityVerified`, and `providerSignInVerified`. That last gate is a list of provider ids whose real sign-in was verified on the production origin. It must include every configured provider, so adding a provider means proving it again before public signup stays open.
   - **Only when `EMAIL_SIGN_IN=on`:** `senderVerified`, `recipientDeliveryVerified` and `MAIL_MODE=http`, as today.
   - Google brand verification is not a gate.
   - The proof stays bound to `RELEASE_COMMIT`, and a version 1 proof is rejected.
4. **The sign-in page asks the gateway which methods are on.** `GET /auth/methods` returns the configured provider ids and whether email sign-in is on. The page draws one button per provider, so a new provider needs no page change. The response reveals nothing about any account.
5. **`SIGNUP_MODE` stays `owner-only` by default.** That applies in `compose.deploy.yml` and the gateway. Nothing about the owner-only launch changes.

## Consequences for the spec

- This depends on Better Auth 1.7 (`validateUserInfo`), already required by the linking decision.
- `signupEnabled()` changes:
  - It accepts the version 2 proof.
  - It requires mail checks only when email sign-in is on.
  - It drops the unconditional `MAIL_MODE=http` requirement for public signup.
- Local development and CI sign in with email codes today (`MAIL_MODE=file`, `SIGNUP_MODE=owner-only` in `scripts/ci.sh`). Until the fake provider from [Decide how local dev and CI fake provider sign-in](https://github.com/ry-cen/prizecheck/issues/134) lands, they set `EMAIL_SIGN_IN=on`. Afterwards, only the tests that cover email codes turn it on.
- Gateway and auth tests cover each `SIGNUP_MODE` × action (create, link, sign-in) for the owner and non-owners, the email switch at both layers, approval codes with email sign-in off, and the readiness proof with email sign-in on and off.
- Registering real Google and Discord credentials isn't a decision. It's launch work that the version 2 proof's `providerSignInVerified` gate requires. The spec should include the owner's console checklist.
