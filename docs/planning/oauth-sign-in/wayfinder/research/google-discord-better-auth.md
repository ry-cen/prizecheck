# Google and Discord sign-in under Better Auth

**Label:** wayfinder:research · **Ticket:** [#129](https://github.com/ry-cen/prizecheck/issues/129) · **Map:** [OAuth sign-in decision map](../map.md) · **Researched:** 2026-10-12

This note reports facts and options. It makes no product decisions.

## Which Better Auth we actually run

`package.json` declares `"better-auth": "^1.4.0"`, but `package-lock.json` resolves **1.7.6** (`@better-auth/core` 1.7.6). The latest release is 1.7.7, and the `release-1.4` dist-tag points at 1.4.22 (`npm view better-auth dist-tags`). Every source citation below is to the installed 1.7.6 code under `node_modules/better-auth/dist` and `node_modules/@better-auth/core/dist`. I also checked the 1.4.22 tarball where behaviour differs.

| Option / hook | 1.4.22 | 1.7.6 (locked) |
|---|---|---|
| Per-provider `disableSignUp`, `disableImplicitSignUp` | yes | yes |
| `account.accountLinking.trustedProviders`, `disableImplicitLinking`, `allowDifferentEmails` | yes | yes |
| `account.encryptOAuthTokens`, `updateAccountOnSignIn`, `storeAccountCookie` | yes | yes |
| `databaseHooks.{user,account,session}.create.before` | yes | yes |
| `disabledPaths` | yes | yes |
| `user.validateUserInfo` (one gate for create-user / link-account / sign-in) | **no** | yes |
| `account.accountLinking.requireLocalEmailVerified` (default `true`) | **no** (the gate doesn't exist) | yes, marked deprecated "the gate will become unconditional" |
| Per-provider `requireEmailVerification` | **no** (not in `oauth2/link-account.mjs` or `callback.mjs`) | yes |

**Consequence:** if the lockfile ever resolved back to 1.4.x, a pre-existing *unverified* local user at someone's address could be implicitly linked to that person's verified OAuth identity. 1.7.6 refuses this by default (`requireLocalEmailVerified ?? true` in `oauth2/link-account.mjs`).

## 1. Scopes and what each provider returns

Better Auth requests these default scopes. Both are enough for sign-in, and neither provider needs extra scopes.

| | Google | Discord |
|---|---|---|
| Default scopes (Better Auth) | `email profile openid` (`social-providers/google.mjs`) | `identify email` (`social-providers/discord.mjs`) |
| PKCE | required (`codeVerifier is required for Google`) | not used |
| Profile source | decoded ID token (`decodeJwt(token.idToken)`). No userinfo call is made. | `GET https://discord.com/api/users/@me` with the access token |
| Stable account id → `account.accountId` | `sub` (`accountSubject: profile.sub`) | `id` snowflake (`accountSubject: profile.id`) |
| Email | `email` claim | `email`, nullable `?string` |
| Provider vouches email verified → `user.emailVerified` | `email_verified` claim | `verified` boolean |
| Display name → `user.name` | `name` | `global_name \|\| username \|\| ""` |
| Avatar → `user.image` | `picture` | CDN URL built from `avatar` hash, or the default embed avatar when the hash is null |

Primary-source notes:

- **Google.** "Use `sub` within your application as the unique-identifier key for the user". You shouldn't use `email` as an identifier because it "could change over time". The `email` scope adds the `email` and `email_verified` claims. `email_verified` is "True if the user's email address has been verified; otherwise false." `name` and `picture` come with `profile` but are "never guaranteed to be present." `hd` is present only for Workspace and Cloud-organisation accounts. ([Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect))
- **Discord.** `identify` returns `id`, `username`, `global_name` and `avatar`. `email` returns `email` (`?string`) and `verified` ("Whether the email on the account has been verified"). ([Discord User resource](https://docs.discord.com/developers/resources/user), [Discord OAuth2](https://docs.discord.com/developers/topics/oauth2))
- Better Auth fixes `accountId` from the provider subject, not the email. A user who changes their Google or Discord email still reaches the same `account` row on the next sign-in.

## 2. Discord accounts with an unverified email, or none

- **No email.** Better Auth's Discord page says Discord "returns `email: null` for phone-only accounts, even with the `email` scope granted" ([Better Auth Discord](https://www.better-auth.com/docs/authentication/discord)). The shared callback rejects any provider result that has no email. `api/routes/callback.mjs` does `if (!userInfo.email) … redirectOnError(EMAIL_NOT_FOUND)` before any user lookup or creation. The only way around this is a `mapProfileToUser` fallback that invents an address, and the docs offer that as an option.
- **Unverified email.** By default Better Auth **creates** the user with `emailVerified: false`. The gates that can refuse it, by when they act:

| Mechanism | What happens | Prevents the row? |
|---|---|---|
| `user.validateUserInfo` returning `{ error }` when `user.emailVerified !== true` (1.7 only) | Runs before `createUser` and before `linkAccount`, and is told the action and provider. A rejection redirects with that error code. | **Yes** |
| `databaseHooks.user.create.before` returning `false` (1.4 and 1.7) | `createWithHooks` returns `null`. `createdUser.id` then throws, and the error is caught as `unable_to_create_user` (`oauth2/link-account.mjs`, `db/with-hooks.mjs`). | **Yes**, but the error code is crude |
| Per-provider `requireEmailVerification: true` (1.7 only) | Its doc comment says "the user and account are still created/linked, but no session is issued" and redirects `?error=email_not_verified`. The check reads the *local* `emailVerified`. | **No.** The row and its Unsorted root still exist. |
| Implicit-linking rule (built in) | Linking to an existing user requires the provider's `emailVerified`, unless the provider is in `trustedProviders`. | Not applicable to creation |

**Squatting interaction (1.7):** under public signup, suppose an unverified Discord email creates a row at `alice@example.com` with `emailVerified: false`. Alice's later Google sign-in then fails with `account_not_linked`, because `requireLocalEmailVerified` refuses to link into an unverified local row. Only a create-time rejection, the first two rows in the table, prevents that state.

## 3. Consent screen, brand verification, app review, launch limits

### Google (Google Auth Platform)

- `openid`, `email` and `profile` are the pre-filled sign-in scopes and are classed **non-sensitive**. Apps that use only non-sensitive scopes do not need OAuth app verification. To show "an app name and logo on the consent screen", they need the lighter **brand verification**. ([Google: OAuth app verification](https://support.google.com/cloud/answer/13463073))
- Brand verification is required when the app is **External** and **In production** *and* wants to show its logo or display name. The listed exemptions include "personal use by you or a few people you know personally" and development, testing or staging projects. Requirements:
  - a publicly reachable homepage that is not only a login page
  - a privacy policy on the same domain, linked from the homepage and the consent screen
  - authorized domains verified in Google Search Console

  The automated check takes minutes. A manual review "usually takes 2-3 business days". ([Google: brand verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification), [verification requirements](https://support.google.com/cloud/answer/13464321))
- **Testing** status allows at most 100 test users, and "Authorizations by a test user will expire seven days from the time of consent." **In production** has no user list. ([Google: publishing status](https://support.google.com/cloud/answer/15549945))
- **Launch blockers:**
  - Testing status caps signups at 100 listed users.
  - Showing the PrizeCheck name and logo requires a verified production domain, a public homepage and a privacy policy.
  - Staging and production redirect hosts must be on verified authorized domains.

### Discord

- The Discord OAuth2 docs single out only some scopes, such as `identify.premium`, `dm_channels.read` and `voice`, as needing Discord approval. `identify` and `email` are not on that list. ([Discord OAuth2](https://docs.discord.com/developers/topics/oauth2))
- **I found no primary source that requires app review or verification, or sets a user cap, for an `identify`+`email` login app.** Bot verification appears to concern bots, but I found it only in forum and secondary posts, so it is not cited here. Confirm in the Developer Portal when registering.
- Better Auth sends `prompt=none` to Discord by default. Discord then skips the authorisation screen for a user who has already authorised these scopes (the `prompt` parameter in the Discord OAuth2 docs). Override it with the provider's `prompt: "consent"` option if every sign-in should show the screen.

### Repo launch readiness (fact, from `auth/src/signup.ts`)

`signupEnabled()` in `public` mode throws unless:

- `MAIL_MODE === 'http'`, and
- the readiness proof sets every gate to `true`: `authorizedByOwner`, `senderVerified`, `recipientDeliveryVerified`, `ownerWalkthroughVerified`, `recoveryVerified`, `privacyVerified`, `capacityVerified`.

So with today's proof schema, public signup cannot be opened on OAuth readiness alone. Mail sender and delivery proof is still required. The map's "OAuth-appropriate readiness proof" needs a schema change.

## 4. Redirect URIs behind the same-origin gateway

- Better Auth builds `redirectURI = ctx.context.baseURL + getOAuthCallbackPath(provider)`. `baseURL` already includes `basePath`, so with `baseURL: PUBLIC_ORIGIN` and `basePath: "/api/auth"` (`auth/src/auth.ts`) every provider uses **`${PUBLIC_ORIGIN}/api/auth/callback/<providerId>`** (`oauth2/utils.mjs`, `api/routes/callback.mjs`). A per-provider `redirectURI` option can override it.
- Concretely:
  - Local: `http://localhost:5173/api/auth/callback/google` and `…/discord`. This works because Vite proxies `/api` to the gateway (`web/vite.config.ts`).
  - Staging and production: `https://<host>/api/auth/callback/{google,discord}`, through nginx's `location ~ ^/(api|auth)/` → gateway (`deploy/docker/nginx.conf`).
- **Google rules:**
  - The URI must match exactly, including scheme, case and trailing slash.
  - HTTPS is required except on localhost, and raw IPs are refused except loopback.
  - No wildcards, no fragments, and the TLD must be on the public suffix list.

  ([Google web-server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server), [OIDC](https://developers.google.com/identity/openid-connect/openid-connect))
- **Discord:** `redirect_uri` "is whatever URL you registered", and the token exchange must send the same value. ([Discord OAuth2](https://docs.discord.com/developers/topics/oauth2))
- **Local pitfalls:**
  - Vite binds `127.0.0.1`, but the default `PUBLIC_ORIGIN` is `http://localhost:5173`. The browser must use the host that `PUBLIC_ORIGIN` names, or the exact-match URI and the host-scoped `state` cookie break.
  - `WEB_PORT` varies per concurrent dev server in the verification gate. Each port is a distinct redirect URI to register, so automated tests want a mock provider instead: an `authorizationEndpoint` override, or `getUserInfo` and token stubs. They should not use real credentials.
- **State:** the database strategy is the default here, with a row in `verification` for 10 minutes and a signed `state` cookie with a 5-minute max-age, `SameSite=Lax` (`state.mjs`, `cookies/index.mjs`). Lax cookies survive the provider's top-level GET redirect back to the callback.

## 5. Gating the callback in the gateway, and the Unsorted root

### The gateway cannot serve an OAuth round-trip today

Reading `auth/src/server.ts`:

1. **Nothing routes to Better Auth's own endpoints.** Any `/api/*` path, including `/api/auth/callback/google`, falls into the `path.startsWith("/api/")` branch. It gets a 401 without a session, or is forwarded to the Python API with one. The gateway only calls `auth.handler` internally, from its own `/auth/request-code`, `/auth/verify-code` and `/auth/sign-out` routes.
2. **`betterRequest(request, path, body)`** builds `new Request(origin + path)`. A callback's query string (`code`, `state`, `error`) would be lost unless `path` includes `search`.
3. **`relay()`** copies only `content-type`, `cache-control` and `set-cookie`. It drops `Location`, so the callback's 302 to `callbackURL` would break.
4. **Do not use a blanket `/api/auth/*` passthrough.** It would expose `/api/auth/email-otp/send-verification-otp` and `/api/auth/sign-in/email-otp` directly, bypassing the owner-only email check and the `allowedSend` caps. That contradicts "email OTP switched off at the endpoint." Options:
   - An explicit allowlist in the gateway: a start route that calls `/api/auth/sign-in/social` and returns its `url` plus the state `Set-Cookie`, and `GET /api/auth/callback/:id` relayed with `Location` and `Set-Cookie`.
   - Better Auth's `disabledPaths: [...]`. `api/index.mjs` returns 404 for listed paths, but only on `auth.handler` and not on `auth.api.*`. The gateway's own OTP routes call `auth.handler`, so disabling the email-otp paths there switches them off at both layers.
5. **`onAPIError: { throw: true }` does not break redirects.** `api/index.mjs` `onError` returns early for `e.status === "FOUND"` before honouring `throw`. Callback failures are themselves redirects. Without an error URL they go to `${baseURL}/error`, which is `/api/auth/error`, also a path the gateway must route or override. Better Auth lets you override it with `onAPIError.errorURL`, or per request with `errorCallbackURL` on `/sign-in/social`.

### What each hook can see, for owner-only and `SIGNUP_MODE`

| Hook | Runs | Sees the email? | Use |
|---|---|---|---|
| `hooks.before` on `/callback/:id` (`createAuthMiddleware`) | before the code exchange | **No.** It has only `code` and `state`. | A kill switch per provider or for all OAuth. It can't do owner-only. |
| Per-provider `disableSignUp: !signupEnabled()` | `handleOAuthUserInfo`, when no user matches | n/a | Cheapest mapping of `SIGNUP_MODE` to "no new accounts". The existing owner row still links and signs in. Returns `signup_disabled`. |
| `disableImplicitSignUp` + `requestSignUp` on `/sign-in/social` | same place | n/a | Lets the start route opt in to signup per request. |
| `user.validateUserInfo` (1.7) | before `create-user`, `link-account` and OAuth `sign-in`. Gets `{ user, source: { action, method, oauth: { providerId, profile } } }`, and for link and sign-in `user.id` is the local user. | Yes (the provider's fresh email) | **One provider-agnostic gate.** For example: refuse when `!publicSignup` and the user isn't the owner (by `owner_binding.user_id` on link/sign-in, by `OWNER_EMAIL` on create), and refuse `create-user`/`link-account` unless `user.emailVerified === true`. It fails closed if it throws. It also fires for the `email-otp` method. |
| `databaseHooks.user.create.before` | inside `createUser` | Yes | 1.4-compatible creation gate (see §2 for the error-code caveat). |
| `databaseHooks.account.create.before` | `createAccount` **and** `linkAccount` (both use `createWithHooks`) | Has `providerId`, `accountId`, `userId`, not the email | Refuse links to non-owner users in owner-only mode. |
| `databaseHooks.session.create.before` | `createSession` | Has `userId` | 1.4 way to refuse sign-in for an existing non-owner user. `false` → `unable_to_create_session`. |

Today's gateway refuses every non-owner email in owner-only mode, including for existing accounts. `disableSignUp` alone only stops *new* accounts. Matching the current behaviour exactly also needs a sign-in gate, either `validateUserInfo` or `session.create.before`.

### Unsorted root

`migrations/020_signup.sql` installs `onboard_auth_account`, an `AFTER INSERT ON "user"` trigger. It inserts `inventory_owner` and the `Unsorted` `storage_leaf` location in the same statement. Any Better Auth creation path, OTP or any OAuth provider, therefore gets its Unsorted root with no hook changes. In 1.7.6, `handleOAuthUserInfo` creates the user and account inside `runWithTransaction`, so a failed account insert rolls back the user and its Unsorted root. A creation refused by `validateUserInfo` or `user.create.before` inserts nothing and fires no trigger. `requireEmailVerification` does insert, so it fires the trigger.

## Linking the owner by email

From `oauth2/link-account.mjs` (`handleOAuthUserInfo`, 1.7.6):

- The lookup order is `findAccountOwnerByKey(providerId, accountId)` first, then `findUserByEmail(userInfo.email.toLowerCase())`. The match is exact after lowercasing, with no Gmail dot or plus normalisation.
- Implicit linking to the existing row is refused (`account_not_linked`) if any of these hold:
  - the provider's `emailVerified` is false and the provider isn't in `trustedProviders`, which defaults to `[]` (`context/helpers.mjs`)
  - the local row's `emailVerified` is false (1.7 `requireLocalEmailVerified`)
  - `accountLinking.enabled === false` or `disableImplicitLinking === true`
- The owner's row is `emailVerified: true`, because email-OTP sign-in sets it (`plugins/email-otp/routes.mjs`). `scripts/operations_mail.py` also already requires it. The owner's Google and Discord sign-ins at `OWNER_EMAIL` will therefore link **only if Google's `email_verified` or Discord's `verified` is true**.
- Adding a provider to `trustedProviders` skips the provider-verified check. That is the account-takeover vector Better Auth warns about ([Users & Accounts](https://www.better-auth.com/docs/concepts/users-accounts)).
- A successful link never changes the local `email` or `emailVerified`. `updateUserInfoOnLink`, default `false`, would copy name and image only.
- Explicit linking while signed in (`linkSocial`) requires matching emails unless `allowDifferentEmails` is set, and the same verified-or-trusted rule applies (`linkOAuthAccount`).

## 6. What the `account` table stores, and turning tokens off

`migrations/002_auth.sql` `account` columns: `id`, `accountId` (provider subject), `providerId`, `userId`, `accessToken`, `refreshToken`, `idToken`, `accessTokenExpiresAt`, `refreshTokenExpiresAt`, `scope`, `password`, `createdAt`, `updatedAt`.

On OAuth create or link, Better Auth writes `accessToken`, `refreshToken`, `idToken`, both expiries and `scope`. On each later sign-in it rewrites the tokens and expiries but not `scope`, because `updateAccountOnSignIn` defaults to `true` (`oauth2/link-account.mjs`).

- **Google:** gives an access token, and an ID token that contains the email, name and picture. A refresh token comes only with `access_type=offline` ([Google web-server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server)). Better Auth sends `access_type` only if `accessType` is configured, so by default there is no refresh token.
- **Discord:** always returns `access_token` and `refresh_token`, with an `expires_in` of 604800 in the example ([Discord OAuth2](https://docs.discord.com/developers/topics/oauth2)). It has no ID token.

**There is no option to stop storing tokens.** The available levers:

- `databaseHooks.account.create.before` and `account.update.before` returning `{ data: { accessToken: null, refreshToken: null, idToken: null, accessTokenExpiresAt: null, refreshTokenExpiresAt: null } }`. `createWithHooks`/`updateWithHooks` merge `result.data` over the row, so this strips them on create, link and sign-in.
- `account.encryptOAuthTokens: true`: AES-256-GCM via `setTokenUtil`. It applies to `accessToken` and `refreshToken` only. **`idToken` is still stored in plain text.**
- `account.updateAccountOnSignIn: false`: stops later rewrites. The first create still stores tokens.
- `storeAccountCookie` stays `false` here because a database is configured. Turning it on would put the tokens in an encrypted cookie.

## 7. Keeping a third provider to configuration plus credentials

Already provider-agnostic in Better Auth:

- one callback path pattern (`/callback/:id`)
- one `handleOAuthUserInfo`
- `accountId` taken from each provider's subject
- one `account` table keyed `(providerId, accountId)`
- the Unsorted trigger on `user`

To keep it that way:

- Use a provider-agnostic gate: `validateUserInfo`, keyed on `source.method === "oauth"` and `user.emailVerified`, not on `providerId`. The `SIGNUP_MODE` mapping should be applied in a loop over the configured providers.
- Make the gateway allowlist route `/api/auth/callback/:id` for any id in `Object.keys(socialProviders)`, not hard-coded names. The same applies to any token-stripping hook.
- Build the provider list from env, adding a provider only when its `*_CLIENT_ID` and `*_CLIENT_SECRET` are set. A new provider is then a config entry, two secrets and a registered redirect URI.
- **The real limit is email verification.** A provider that never asserts a verified email can neither link to the owner nor pass an `emailVerified` creation gate. Better Auth's own `requireEmailVerification` doc comment warns that "several providers always report the email as unverified" (`@better-auth/core/dist/oauth2/oauth-provider.d.mts`). Such a provider would need a new decision unless it is trusted, which is the takeover risk.

## Open items for the HITL credentials task

- Google: an External project and a production domain verified in Search Console, a public homepage and privacy policy for brand verification, and each environment's exact callback URI.
- Discord: an application with each environment's exact callback URI. Confirm in the portal that no review applies.
- Choose the local dev host that matches `PUBLIC_ORIGIN`, and decide whether tests use a mock provider.
