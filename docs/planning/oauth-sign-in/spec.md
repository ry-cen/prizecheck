# OAuth sign-in for PrizeCheck

**Status:** published 2026-10-12, `ready-for-agent`. Next step: owner-invoked `/to-ticket`.

This spec turns the eight resolutions of the [OAuth sign-in decision map](wayfinder/map.md) into one implementation handoff. Details that no resolution settled are listed under "Details settled at publication" in Further Notes.

## Problem Statement

Collectors can sign in to PrizeCheck only with a six-digit code sent by email. That works for the owner-only launch, but it blocks the next step. Public signup is gated on proving that a sending domain is verified and that a real recipient receives a code, so opening the product to other collectors depends on mail delivery being reliable. Many collectors also expect to sign in with an account they already use, such as Google or Discord, and a code in an inbox is slower than a button.

Adding those buttons raises problems that the current design does not have:

- The owner-only rule is enforced today only by the gateway's email-code routes, which check the email before sending a code. An OAuth callback has no such check, so a Google or Discord sign-in could create an account on an owner-only deployment.
- The owner already has an account and data. Their first Google or Discord sign-in at the owner's address must reach that account, not create a second one.
- Linking by email is an account-takeover risk if a provider reports an unverified address, and Discord can report no address at all. An unverified address must never create an account, because it could squat on the real owner's address.
- The readiness proof for public signup requires mail checks. Collectors who never use email codes should not be held to them.
- Better Auth's pinned range (`^1.4.0`) allows versions that lack the checks this design depends on.
- Better Auth stores provider access, refresh and ID tokens that PrizeCheck never uses.
- Sign-in cannot be tested against real Google and Discord accounts in local development and CI, and a test fake must never be able to run in production.

## Solution

Add Google and Discord as the sign-in methods collectors see. Sign-in creates accounts under the existing `SIGNUP_MODE` gate, which stays owner-only by default. Email-code sign-in stays built but is switched off by default, and the switch is enforced at the gateway and in Better Auth, not only hidden in the page. Owner approval codes and operations mail keep using email and are unchanged.

The design rests on a few rules that hold for every provider:

- **One linking rule.** A sign-in links to an existing collector by email only when the provider and the existing account both have the email verified. An unverified or missing provider email is refused before any row is written. Returning sign-ins match on the provider's account id, so changing an email at the provider does not lose the account. The owner moves over by this rule, at `OWNER_EMAIL`.
- **One gate.** A single Better Auth `validateUserInfo` hook decides create, link and sign-in under `SIGNUP_MODE`, and enforces the creation limits. It never looks at which provider is used.
- **Two gateway routes for the flow, plus a few for the Sign-ins page.** The sign-in start and the provider callback are explicit gateway routes. Every other path under `/api/auth/` returns 404.
- **Minimal profile data.** Only the provider account id, display name and picture URL are kept. Name and picture are private to the signed-in collector. Provider tokens are never stored.
- **A Sign-ins settings page.** Collectors list, link and unlink their sign-ins, never removing the last one, and only after a recent sign-in.
- **Limits.** Account creation is limited per IP and app-wide per day, and sign-in starts are limited per IP per hour.
- **A readiness proof version 2** that proves real sign-in for every configured provider and asks for mail checks only when email sign-in is on.
- **A test fake** that runs the real Google and Discord provider code and fakes only the provider HTTP traffic and consent page. It is loaded by the test launcher only and cannot ship.

Adding a third provider takes configuration, credentials and one test-fake entry. It needs no new gateway route, page change or decision, as long as the provider vouches for a verified email.

## User Stories

1. As a collector, I want to sign in with my Google account, so that I do not need an email code or a password.
2. As a collector, I want to sign in with my Discord account, so that I can use an account I already have.
3. As a collector, I want the sign-in page to show exactly the sign-in methods that are available, so that I never press a button that cannot work.
4. As a developer, I want the sign-in buttons drawn from the gateway's list of configured providers, so that a new provider needs no page change.
5. As a collector, I want a sign-in button to be a plain link, so that it opens normally, including in a new tab.
6. As a collector following a protected link, I want to return to that page after signing in, so that I can continue my task.
7. As a collector, I want the return destination limited to a page inside PrizeCheck, so that a crafted link cannot send me to another site after I sign in.
8. As a collector with no destination, I want to land on my Collection after signing in, so that I start where my cards are.
9. As a collector, I want my session to behave exactly as it does today (30 days, rolling, same-origin Secure HttpOnly SameSite=Lax cookie), so that moving to Google or Discord does not change how long I stay signed in.
10. As a collector, I want to sign out as I do today, so that another person on my device cannot reach my Collection.
11. As a collector who cancels at the provider, I want to be told sign-in was cancelled and see the sign-in buttons again, so that I can choose another way.

12. As a new collector, I want my first Google or Discord sign-in to create my account when signup is open, so that I can start using PrizeCheck without a separate registration.
13. As a new collector, I want my new account to start with an Unsorted root Storage Leaf, so that I can add cards straight away.
14. As a new collector, I want my account created only when the provider vouches that my email is verified, so that nobody can create an account in my name with an address I do not control.
15. As a new collector whose provider email is unverified, I want a clear message to verify it with that provider, so that I know how to fix it.
16. As a new collector whose Discord account has no email, I want the same message, so that I understand why I cannot sign in.
17. As a collector with an unverified provider email, I want nothing created for me (no account, no Unsorted root, no provider link), so that my attempt cannot block the real owner of that address later.
18. As a new collector on an owner-only deployment, I want a plain "PrizeCheck isn't open for new sign-ins yet" message, so that I know to come back later.
19. As a new collector, I want that message to be the same whether or not my email matches an existing collector, so that the sign-in flow does not reveal who has an account.

20. As the owner, I want my first Google sign-in at the same address as `OWNER_EMAIL` to reach my existing account and its data, so that I do not lose my Collection when I move off email codes.
21. As the owner, I want my Discord sign-in at the same address to link to the same account, so that either provider reaches my data.
22. As the owner, I want to remain identified by `OWNER_EMAIL` after I link a provider, so that owner controls keep working with no further setup.
23. As the owner on a fresh deployment with no account yet, I want my first sign-in at `OWNER_EMAIL` to create the owner account, so that I can set up the deployment through a provider.
24. As a returning collector, I want to be recognised by my provider's account id, so that changing my Google or Discord email does not lose my account.
25. As a collector, I want my own account email never to be rewritten by a sign-in or a link, so that my identity does not change under me.
26. As a collector with an existing account, I want a first-time sign-in with a provider whose verified email matches mine to link to that account, so that I do not get a duplicate empty account.
27. As a collector, I want the email match to ignore letter case but otherwise be exact, so that matching is predictable.
28. As a collector whose existing account email is unverified, I want automatic linking refused, so that no one can take over an unverified account by registering a provider with that address.
29. As a collector, I want no provider to be treated as trusted, so that linking never depends on which provider is used.
30. As a collector whose Discord email differs from my account email, I want to be given a separate unlinked attempt rather than a silent merge, so that accounts are only joined by an address I own.

31. As the owner, I want email-code sign-in switched off by default, so that PrizeCheck shows only Google and Discord until I decide email is ready.
32. As an operator, I want `EMAIL_SIGN_IN` to turn email-code sign-in on or off, so that I can enable it without a code change.
33. As an operator, I want the gateway to return 404 for the email-code routes when the switch is off, so that nothing is reachable by direct request.
34. As an operator, I want Better Auth itself to refuse the email-code endpoints when the switch is off, so that the switch holds even if a gateway route is added by mistake.
35. As a collector, I want the sign-in page to show no email form when the switch is off, so that I am not offered a method that does nothing.
36. As the owner, I want owner approval codes to keep working while email sign-in is off, so that catalog approvals still need a fresh code.
37. As an operator, I want operations alert mail to be unchanged, so that I still hear about backup and catalog failures.
38. As an operator, I want a production start with `EMAIL_SIGN_IN=on` refused unless `MAIL_MODE=http`, so that a fake mail mode cannot serve real collectors.
39. As the owner, I want email-code sign-in to keep working when I turn the switch on, including for the owner account, so that the built feature is ready when I need it.

40. As an operator, I want `SIGNUP_MODE` to stay `owner-only` by default, so that the owner-only launch is unchanged.
41. As an operator, I want one gate to cover create, link and sign-in for every method, so that no path bypasses `SIGNUP_MODE`.
42. As an operator, I want the gate to fail closed, so that an error in the gate refuses sign-in rather than allowing it.
43. As the owner, I want an owner-only deployment to let only the owner sign in or link, so that nobody else gains access through a provider.
44. As an operator, I want public signup to open only on a version 2 readiness proof, so that opening it is a deliberate, recorded act.
45. As the owner, I want the proof to require a verified real sign-in for every configured provider on the production origin, so that I never open signup on a provider I have not tried.
46. As the owner, I want adding a provider to require proving it again, so that public signup does not stay open on an untested button.
47. As the owner, I want mail sender and delivery checks required only when email sign-in is on, so that OAuth-only collectors are not held to mail readiness.
48. As the owner, I want Google brand verification not to be a gate, so that it does not block launch.
49. As an operator, I want a version 1 proof rejected, so that an old proof cannot open signup under the new rules.
50. As an operator, I want the proof bound to `RELEASE_COMMIT`, so that it covers the build that is running.

51. As a collector, I want `GET /auth/methods` to list the configured providers and whether email sign-in is on, so that the page can draw the right buttons.
52. As a collector, I want that response to reveal nothing about any account, so that it is safe to call before sign-in.
53. As a developer, I want the gateway to expose a start route and a callback route for any configured provider, so that a new provider needs no new route.
54. As an operator, I want an unknown provider in either route to return 404, so that only configured providers can be reached.
55. As an operator, I want every other `/api/auth/` path to return 404 from the gateway and never reach the API, so that Better Auth's other endpoints cannot be reached directly.
56. As a developer, I want the callback to keep its query string and pass back the redirect and cookies, so that the provider's response completes the sign-in.
57. As a collector, I want any error to land on the sign-in page with a code in the address, so that I see a message instead of a raw error page.

58. As a collector, I want my provider name and picture shown in the signed-in app, so that I can see which account I am using.
59. As a collector, I want my name and picture shown only to me, so that they never appear on a Published Deck, Discover or any public response.
60. As a collector, I want the name and picture to follow my latest sign-in or link, so that they stay current when I change them at the provider.
61. As the owner, I want my empty name and picture filled when I first link a provider, so that my account is not left blank.
62. As a collector with no name or picture, I want the first letter of my email shown as my avatar, so that the app still has something to show.
63. As a collector, I want only my provider's account id, display name and picture URL kept, so that PrizeCheck holds the least data it needs.
64. As a collector, I want provider access, refresh and ID tokens never stored, so that a database leak cannot be used to act on my Google or Discord account.
65. As a developer, I want each provider entry to carry its image host, so that a later content-security policy can allow it without a new decision.
66. As an operator, I want name and picture covered by the privacy check and the backups, so that they are treated as personal data.

67. As a collector, I want a Sign-ins page in my avatar menu on desktop and the More sheet on mobile, so that I can find it beside Owner controls and Sign out.
68. As a collector, I want the page to list every configured provider with the date I linked it or a Connect button, so that I can see my sign-ins at a glance.
69. As a collector, I want my own email shown once at the top of the page, so that I know which address my account uses.
70. As a collector, I want provider account ids and emails not shown on the page, so that nothing sensitive sits on screen.
71. As a collector, I want to connect a second provider while signed in, even if its email differs from mine, so that I can use whichever account I have to hand.
72. As a collector, I want a deliberate link still to need a verified provider email, so that the same rule holds everywhere.
73. As a collector, I want a provider account already connected to a different PrizeCheck account refused, so that no one's account can be taken by linking.
74. As a collector, I want that refusal not to reveal which collector holds the account, so that I learn nothing about anyone else.
75. As a collector, I want to remove a sign-in I no longer use, so that I can clean up my account.
76. As a collector, I want the last sign-in to be impossible to remove, so that I cannot lock myself out.
77. As a collector with one sign-in, I want the Remove button hidden, so that the page does not offer an action that cannot work.
78. As a collector, I want changes to my sign-ins to need a sign-in within the last 24 hours, so that a stolen long-lived session cannot attach an attacker's account.
79. As a collector with a stale session, I want to be asked to sign in again and returned to the Sign-ins page, so that I can finish what I started.
80. As a collector, I want the unlink request to check the origin, so that another site cannot remove my sign-ins.

81. As a collector, I want one clear message per kind of failure, so that I know what to do next.
82. As a collector, I want unknown failure codes shown as "Didn't complete" with a way to try again, so that I never see a raw code.
83. As a collector, I want the provider's own error text never displayed, so that untrusted text cannot appear in the app.
84. As a collector, I want the error removed from the address bar after it is shown, so that reloading or sharing the page shows no stale error.
85. As a collector using a screen reader, I want the message announced as an alert and focused once, with the sign-in buttons reachable right below it, so that I can recover without hunting for them.
86. As a collector, I want no message to reveal whether an account exists, so that failures leak nothing.

87. As an operator, I want account creation limited to 10 per trusted IP per day, so that one source cannot script accounts.
88. As an operator, I want account creation limited app-wide by `DAILY_SIGNUP_CAP` per day, default 100, so that a burst cannot exceed my capacity envelope.
89. As a returning collector, I want sign-in never throttled by the creation limits, so that I can always get back in.
90. As an operator, I want the gateway to take the client IP itself, never from a request header, so that the IP cannot be spoofed.
91. As an operator, I want creation refused when the gateway supplied no IP, so that the gate fails closed.
92. As an operator, I want sign-in starts limited to 60 per trusted IP per hour, so that the verification table cannot be grown cheaply.
93. As a collector who hits a limit, I want a "Too many sign-ins right now. Try again later." message, so that I know to wait.
94. As the owner, I want the owner panel to show new accounts in the last day against `DAILY_SIGNUP_CAP` and warn at 80%, so that a cap does not surprise me.
95. As the owner, I want refusals counted in the existing bounded auth counters, so that I can see pressure without personal data in logs.

96. As a developer, I want to sign in locally as the owner, a new collector or an unverified account with one click and no credentials, so that I can work on any flow offline.
97. As a developer in CI, I want the real Google and Discord provider code to run with only the provider HTTP traffic faked, so that PKCE, profile mapping, linking, the gate and the routes are all tested for real.
98. As a developer, I want any request to a real provider host from a test to fail loudly, so that no test ever reaches Google or Discord.
99. As a developer, I want the existing browser journeys to sign in as the owner through the fake consent page, so that they exercise the production sign-in path.
100. As a developer, I want one journey to cover the failure messages and the Sign-ins page, so that the user-visible flow is tested end to end.
101. As an operator, I want the fake to be impossible to ship, so that a test identity can never sign in as the owner on a deployed host.
102. As a developer, I want a guardrail test that fails if shipped auth code imports the fake, so that the separation cannot erode.
103. As an operator, I want the fake to refuse to load unless the public origin is a loopback address, so that a mistaken launch flag on a deployed host fails at startup.
104. As a developer, I want a third provider to take configuration, credentials and a test-fake entry only, so that adding one stays cheap.
105. As the owner, I want a checklist for the Google and Discord consoles, so that I know exactly what to register before launch.
106. As an operator, I want Better Auth's version floor raised to 1.7, so that the lockfile cannot fall back to a version where an unverified local account could be linked.

## Implementation Decisions

Facts and sources: [Google and Discord sign-in under Better Auth](wayfinder/research/google-discord-better-auth.md) and [running OAuth sign-in locally and in CI](wayfinder/research/oauth-local-and-ci.md). This effort is additive to the stack in [ADR 0001](../../adr/0001-react-python-workers-auth-boundary.md) and [ADR 0002](../../adr/0002-defer-deployment-provider-selection.md): React and Vite, FastAPI, PostgreSQL and Better Auth stay. Email codes are not removed. Vocabulary follows the project glossary (collector, Collection, Unsorted, Published Deck, Discover).

### Terms used in this spec

- **Linked sign-in:** a Google or Discord account connected to one collector. Better Auth stores it as a row keyed by provider id and the provider's own account id.
- **Sign-in method:** one of the configured providers, or email codes when `EMAIL_SIGN_IN` is on.
- **Sign-ins page:** the signed-in settings page at `/settings/sign-ins`.
- **Refusal:** a sign-in, link or creation the gate or a limit rejects. Every refusal carries one error code and says nothing about any account.

### Modules and interfaces

Modules are named by role. The sections below give each one's behaviour.

| Module | Builds or changes | Interface |
| --- | --- | --- |
| Gateway | Adds the methods, sign-in start, callback, link, unlink and list routes, the 404 for other `/api/auth/*` paths, the start limiter, the per-request IP context and the email-code 404 | HTTP routes in the contract below. Passes the query string and `Location` through for the OAuth routes only. |
| Auth configuration | Social providers from environment, account linking, profile override, token-nulling hooks, `disabledPaths`, error URL | Builds both Better Auth instances from one configuration. Exposes the configured provider list (id, display name, image host) to the gateway. |
| Signup gate | The single `validateUserInfo` function plus the creation-limit check | Input: action, method, user, provider profile. Output: allow, or one error code. Reads the IP context. Fails closed. |
| Creation limiter | `auth_rate_event` checks, pruning and the daily count | Called by the gate under the advisory lock. Also read by the owner panel's source (below). |
| Signup readiness | `signupEnabled()` for the version 2 proof | Reads `SIGNUP_MODE`, `EMAIL_SIGN_IN`, `MAIL_MODE`, the proof file and `RELEASE_COMMIT`. Returns whether signup is open, or throws. |
| OAuth test fake | Interceptor for provider HTTP and the fake consent page | Preloaded by the launcher. Identities by `code`. Refuses a non-loopback origin. Imports nothing from, and is imported by nothing in, the shipped auth source. |
| Sign-in page | Provider buttons, email form (when on), message mapping | Reads `GET /auth/methods` and the `error` query parameter. |
| Sign-ins page | List, connect, remove, message mapping | Reads `GET /auth/sign-ins` and `GET /auth/session`. Calls the link and unlink routes. |
| Owner panel | New-accounts-in-a-day figure against `DAILY_SIGNUP_CAP`, warning at 80% | See the open data path below. |

- **Owner panel data path.** The API computes the figure, as it does the other operational figures. It reads the last day's `auth_rate_event` rows directly. `DAILY_SIGNUP_CAP` is passed to both the gateway and the API, and both default it to 100.

### Better Auth configuration

- **Raise the dependency floor to 1.7.** The manifest range `^1.4.0` allows 1.4, which lacks `validateUserInfo`, per-provider `requireEmailVerification` and the unconditional local-verified link check. The lockfile already resolves 1.7.6. Raise the range so it cannot fall back, and keep the lockfile at 1.7.x.
- **Providers from environment.** Build the social provider list from environment variables. A provider is configured only when both its `<PROVIDER>_CLIENT_ID` and `<PROVIDER>_CLIENT_SECRET` are set: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`. Each entry carries its provider id, display name and image host (Google `googleusercontent.com`, Discord `cdn.discordapp.com`). A provider with only one of the two variables set is a startup error. Default scopes stay: Google `email profile openid` with PKCE, Discord `identify email`. Google `accessType` stays unset, so no refresh token is requested. Discord keeps Better Auth's default `prompt=none`.
- **Account linking.** Turn account linking on with `trustedProviders` empty, `allowDifferentEmails: true` and `updateUserInfoOnLink: true`. Leave `requireLocalEmailVerified` at its default (on) and `allowUnlinkingAll` off. Leave `encryptOAuthTokens` unused.
- **Profile follows latest sign-in.** Set `overrideUserInfoOnSignIn` for every configured provider. If a provider omits a field, the existing value stays.
- **Token nulling.** `databaseHooks.account.create.before` and `databaseHooks.account.update.before` set `accessToken`, `refreshToken`, `idToken`, `accessTokenExpiresAt` and `refreshTokenExpiresAt` to null on create, link and every sign-in. `scope` stays.
- **Error destination.** Set `onAPIError.errorURL` to the web sign-in page, so Better Auth's own `/api/auth/error` is never routed. Each start also sets `errorCallbackURL` and `newUserCallbackURL` to match its `callbackURL`. The existing `onAPIError.throw` setting stays.
- **Email-code endpoints.** When `EMAIL_SIGN_IN=off`, list the email-code send and sign-in endpoints in `disabledPaths`, so the plugin refuses them even when called internally through the handler. The plugin itself stays registered, so that turning the switch on needs no code change. The resolution names the send and sign-in endpoints. Every other endpoint the plugin registers is listed too, as defence in depth, even though the gateway already makes them unreachable from outside.
- **Both instances.** The gateway builds two Better Auth instances from one configuration (the shared pool and the budgeted-lookup pool). Every setting above applies to both so that cookies and session rules match.
- **Session.** Session length, rolling update and cookie rules do not change. `freshAge` stays at Better Auth's default of 24 hours. Better Auth measures freshness from the session's creation time, which a rolling session does not reset, so "a sign-in within 24 hours" holds even for an active session. The gateway's link check must use the same creation time, so link and unlink share one rule.

### The signup gate

One `user.validateUserInfo` function is the only decision point for create, link and sign-in. It receives the action (create user, link account or sign in), the method (OAuth or email code) and, for OAuth, the provider's fresh profile. It reads `SIGNUP_MODE` once at startup, through the same startup check the gateway uses today, and never branches on the provider id. Any thrown error refuses the attempt.

| Mode | Create user | Link account | Sign in |
| --- | --- | --- | --- |
| `owner-only` | Allowed only when the verified email equals `OWNER_EMAIL` (a fresh deployment with no owner account yet) | Allowed only when the existing user is the `owner_binding` user | Allowed only when the existing user is the `owner_binding` user |
| `public`, `local-public` | Allowed, subject to the creation limits | Allowed by the linking rules | Allowed |

- **Verified email, every mode, OAuth only.** Refuse to create a user or link an account unless the provider vouches for the email (Google `email_verified`, Discord `verified`). A missing email is refused the same way. Better Auth's shared callback already rejects a result with no email (`email_not_found`), and the gate refuses an unverified one (`email_not_verified`). Nothing is written in either case, so no user row, Unsorted root or account row exists afterwards.
- **Owner-only refusal.** Every owner-only refusal returns one code, `sign_in_unavailable`, which says nothing about whether an account exists. The sign-in page also maps Better Auth's own `signup_disabled` to the same "Not open yet" message, so a future configuration that surfaces it lands in the right place.
- **Email-code method.** The gate also runs for email-code sign-in. The `SIGNUP_MODE` rules apply to it unchanged. The "provider vouches" rule does not apply, because the code itself proves the address.
- **Gateway checks stay.** The email-code routes keep their current owner-only email check as a second layer.
- **Linking rules.** Linking by email needs both the provider email and the existing account email verified, matched case-insensitively and exactly (no Gmail dot or plus normalisation). Returning sign-ins look up the provider account id first. The collector's own email and verified flag are never changed by a link or a sign-in.

### Account creation limits

- **Scope.** Only OAuth account creation is limited. Sign-in and linking are never throttled by these limits. In `owner-only` mode only the owner can be created, so the limits matter once signup is `public` or `local-public`. Email-code creation doesn't count, because it already has its own send limits.
- **Checks.** In the create-user branch of the gate, in one transaction under a Postgres advisory lock, count rows in the new `auth_rate_event` table:
  - at most 10 per hashed trusted client IP in the last rolling day;
  - at most `DAILY_SIGNUP_CAP` in total in the last rolling day, default 100.

  A permitted check inserts one row. A creation that fails after the check still counts. Rows older than two days are pruned whenever rows are written. The IP is hashed as in the existing send limiter.
- **IP source.** The gateway computes the trusted client IP as it does today and runs each callback inside a per-request context (a Node `AsyncLocalStorage` store) holding that IP. The gate reads the IP from the context. No request header can set it. A missing context refuses creation.
- **Refusal code.** `too_many_sign_ups`, shown with the "Too many attempts" message.
- **Sign-in start limit.** At most 60 starts per trusted IP per hour, shared between the sign-in start and link start routes. The gateway checks it with the same lock-and-hash pattern, not an in-memory limiter, which would reset per replica. Storage: the new table is generalised to `auth_rate_event(kind, ip_key, created_at)`, with `kind` either `signup` or `start`, so both limits use one table and one pruning rule.
- **How a start refusal reaches the browser.** A start is a plain link, so the gateway answers with a 302 to the sign-in page (or the Sign-ins page for a link start) carrying `error=too_many_sign_ups`.
- **Counters and owner panel.** Add a `too_many_sign_ups` outcome to the existing bounded auth counters. The owner panel shows new accounts in the last day against `DAILY_SIGNUP_CAP` and warns at 80%. The signup warning deliberately sits at 80%, while existing provider-quota warnings fire at 70%.
- **Schema change.** One migration adds `auth_rate_event(kind, ip_key, created_at)`. It's indexed like `auth_send_event`, by kind, IP key and time. It holds no email and no raw IP. Migrations are backward compatible and apply before the new auth build deploys.

### Gateway route contract

The browser talks only to gateway routes. The gateway never passes `/api/auth/*` through. All routes use the shared pool and are not budgeted routes.

| Route | Purpose | Checks | Success | Failure |
| --- | --- | --- | --- | --- |
| `GET /auth/methods` | Lists the configured providers and whether email sign-in is on | None. Reveals nothing about any account. | 200 with each provider's id and display name, plus a flag for email sign-in (exact body proposed) | None expected |
| `GET /auth/sign-in/:provider?next=<path>` | Starts a sign-in | Provider must be configured. `next` must be a safe path. Start limit applies. | 302 to the provider with Better Auth's `state` cookie. Callback target is the checked `next`. | 404 for an unknown provider. 302 to the sign-in page with `error=too_many_sign_ups` when over the start limit. |
| `GET /api/auth/callback/:provider` | Completes sign-in or link | Provider must be configured. Runs inside the IP context. | Relays Better Auth's 302 `Location` and `Set-Cookie`, with the query string intact. | 404 for an unknown provider. Provider and gate errors become a 302 to the sign-in page (or Sign-ins page) with an `error` code. |
| `GET /auth/session` | Session lookup | None | 200 with `signedIn`, `userId`, and for a signed-in collector `name` and `image` (null when absent). The collector's email is added for the Sign-ins page. | None |
| `GET /auth/sign-ins` | Lists the signed-in collector's linked providers | Session required | 200 with the provider id and the date linked for each. No account ids or emails. | 401 without a session |
| `GET /auth/link/:provider` | Starts linking a provider to the signed-in collector | Session required. Provider must be configured. Session must be fresh. Start limit applies. | 302 to the provider. Returns through the same callback route to the Sign-ins page. | 401 without a session. 404 for an unknown provider. Stale session redirects to the Sign-ins page with `error=recent_sign_in_required` (code name proposed). |
| `POST /auth/unlink/:provider` | Removes a linked sign-in | Origin must match. Session required. Session must be fresh. | 200 | 403 for a bad origin. 401 without a session. A stale session is refused with the same `recent_sign_in_required` code. Unlinking the last sign-in is refused by Better Auth (reporting proposed, see below). |
| `POST /auth/request-code`, `POST /auth/verify-code` | Email-code sign-in | Unchanged when `EMAIL_SIGN_IN=on` | Unchanged | 404 when `EMAIL_SIGN_IN=off` |
| `POST /auth/approval-code`, `POST /auth/sign-out` | Owner approval codes and sign-out | Unchanged | Unchanged | Unchanged |
| Any other path under `/api/auth/` | None | Matched before the generic `/api/` branch | None | 404, never forwarded to the API |

- **Unknown provider means not configured.** A provider is valid only if its credentials were present at startup. There are no hard-coded provider names in any route.
- **Safe `next`.** Accept `next` only if it starts with a single `/`, does not start with `//` or `/\`, and does not point into `/api/` or `/auth/`. Otherwise use `/collection`. Better Auth's `trustedOrigins` check on `callbackURL` stays on as a second layer.
- **Query string and redirects.** The gateway's internal call to Better Auth must forward the query string, and its response relay must pass `Location` for these OAuth routes only. The relay keeps its current content-type, cache and cookie handling.
- **Freshness.** Better Auth already enforces `freshAge` for unlinking, comparing the session's creation time with 24 hours (it refuses with its `SESSION_NOT_FRESH` error). The gateway enforces the same comparison for the link start, and maps both to one refusal.
- **Unlinking the last sign-in** is refused by Better Auth. The gateway returns 400 with Better Auth's `FAILED_TO_UNLINK_LAST_ACCOUNT`, and the page shows "Didn't complete".
- **Better Auth's own link, unlink and list endpoints** stay unreachable from outside. Only the gateway routes call them.
- **Error codes on the sign-in page.** The codes the page can receive are listed under "Failure messages".

### Profile and `/auth/session`

- The profile is stored in the user's name and image fields and the provider account row. Nothing else from the provider profile is stored.
- `name` and `image` appear only in the signed-in collector's session response. No FastAPI publication route, Published Deck, Discover or other public response reads them or the collector's email.
- Pictures load directly from the provider's image host and are not copied into PrizeCheck storage. If a content-security policy is added later, its image sources must allow each configured provider's image host.
- Without a name or picture the app shows the first letter of the collector's email as the avatar and no name.
- Backups already include the auth tables. Name and picture join the personal data the privacy check covers.

### Web pages

The visual layout and final copy of the sign-in screen belong to the app-redesign map's "Sign-in and loading screens" work. This spec fixes behaviour only.

- **Sign-in page.** Calls `GET /auth/methods`. Draws one link per configured provider, pointing at the start route with `next` when the collector was sent here from a protected page. Draws the email form only when email sign-in is on. Reads an `error` query parameter, maps it to a message group, announces it as an alert, focuses it once, then removes the parameter from the address bar.
- **Sign-ins page.** Reached from the avatar menu (desktop) and the More sheet (mobile). Lists every configured provider with the date linked or a Connect link, shows the collector's email once at the top, and shows Remove only when more than one sign-in is linked. Uses the same message mapping for its own errors.

### Failure messages

Messages come from a fixed allowlist keyed by the `error` code. Anything not listed shows "Didn't complete". Where a provider is named, it is the configured display name for the provider the attempt used. The table fixes what each message must say, not its wording.

| Group | Codes | Message (gist) | Next step |
| --- | --- | --- | --- |
| Cancelled | `access_denied` | Sign-in was cancelled. | The sign-in buttons |
| Not open yet | `sign_in_unavailable` (and `signup_disabled`) | PrizeCheck isn't open for new sign-ins yet. | None |
| Needs a verified email | `email_not_found`, `email_not_verified` | Your {Provider} account needs a verified email address. | Verify it with {Provider}, or use another sign-in |
| Belongs to another account (Sign-ins page only) | `account_already_linked_to_different_user` | That {Provider} sign-in is already connected to a different PrizeCheck account. | Back to Sign-ins |
| Sign in again (Sign-ins page only) | `recent_sign_in_required` | For your security, sign in again to change your sign-ins. | Sign in, then return to the Sign-ins page |
| Too many attempts | `too_many_sign_ups` | Too many sign-ins right now. Try again later. | None |
| Didn't complete | Everything else, including `invalid_code`, `no_code`, every `state_*`, `please_restart_the_process`, `unable_to_get_user_info`, `oauth_provider_not_found`, `unable_to_link_account`, `unable_to_create_user`, `account_not_linked`, `email_does_not_match`, and unknown codes | Sign-in didn't complete. | Try again |

- The provider's `error_description` and any other free text in the address are never shown.
- `account_not_linked` and `email_does_not_match` should not occur under the linking rules and `allowDifferentEmails`. They are grouped under "Didn't complete" so that no message hints at whether an account exists.
- The "Not open yet" message is about the app, not the person, and is identical whether or not the email matches a collector.

### Readiness proof version 2

`signupEnabled()` for `SIGNUP_MODE=public` accepts a proof with `schemaVersion` 2 and rejects version 1.

- **Always required, true:** `authorizedByOwner`, `ownerWalkthroughVerified`, `recoveryVerified`, `privacyVerified`, `capacityVerified`.
- **`providerSignInVerified`:** a list of provider ids whose real sign-in was verified on the production origin. It must contain every configured provider. This is a list, not a boolean, so the current check that every gate is `true` must treat it separately.
- **Only when `EMAIL_SIGN_IN=on`:** `senderVerified`, `recipientDeliveryVerified` and `MAIL_MODE=http`.
- Unchanged: a non-empty `evidence` string, and `releaseCommit` equal to `RELEASE_COMMIT`.
- Dropped: the unconditional `MAIL_MODE=http` requirement for public signup. Approval codes and operations mail still need working delivery, and the existing guard that refuses file and console mail in production stays.
- Google brand verification is not a gate. The `local-public` mode is unchanged.
- The capacity check covers the creation limits at fixture scale.

### Environment variables

| Variable | Meaning | Default |
| --- | --- | --- |
| `EMAIL_SIGN_IN` | `on` or `off`. Enables email-code sign-in at the gateway and in Better Auth. | `off` everywhere |
| `DAILY_SIGNUP_CAP` | App-wide account creations per rolling day | 100 |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google credentials. Both required to enable Google. | Unset (provider off) |
| `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` | Discord credentials. Both required to enable Discord. | Unset (provider off) |

Existing variables (`SIGNUP_MODE`, `OWNER_EMAIL`, `PUBLIC_ORIGIN`, `MAIL_MODE`, `DAILY_SEND_CAP`, `SIGNUP_READINESS_FILE`, `RELEASE_COMMIT`) are unchanged. The deployment compose file passes the new variables through with `EMAIL_SIGN_IN` defaulting to off and `SIGNUP_MODE` staying `owner-only`. An invalid `EMAIL_SIGN_IN` value is a startup error. A deployment with no provider configured and email sign-in off has no way to sign in. The gateway refuses to start in that case (see the launch order note under the provider console checklist for the `NODE_ENV` caveat).

### Test fake for local development and CI

The decision is in [Decide how local dev and CI fake provider sign-in](wayfinder/resolutions/decide-oauth-test-fake.md), settled by a prototype.

- **Real provider code, fake HTTP.** The real Google and Discord provider code runs in every test. The fake answers Google's token endpoint and Discord's token and `users/@me` endpoints in-process, using msw or an equivalent fetch interceptor installed as a dev dependency only. Pin its version.
- **Identities.** The `code` names a test identity: the owner at `OWNER_EMAIL`, a new collector, an unverified email, a Discord account with no email, and a second owner provider account for linking. The tests also need an identity with a different but verified email, and a consent cancel that returns `access_denied`. A Discord fake profile needs a numeric snowflake id, because Better Auth builds a default avatar from it. A Google fake ID token needs only plausible claims, because the callback does not verify its signature.
- **Fail closed.** Any request to a provider host that the fake does not recognise throws. Paths are decoded before matching, because Better Auth sends `/users/%40me`. Unlisted hosts such as the database and the API pass through.
- **Placeholder credentials.** A provider is configured only when both its id and secret are set, so the CI launcher, each per-stack environment and the local dev script export placeholder credentials for every provider the fake covers (the prototype used `fake-google-client`). Without them `GET /auth/methods` is empty and every start returns 404. The placeholders must never be set in a deployment.
- **Consent page served by the fake.** When the fake is loaded, the sign-in start route answers with a fake consent page instead of a redirect to the provider. It does the same for the link start route, which resolution 134 predates but the Sign-ins page and its tests need. The fake replaces a response only when it is a 302 to a provider host. Every other response passes through unchanged: the 404, the over-limit redirect and the stale-session redirect. The page is produced from the real start response (its `state` cookie and `redirect_uri`) and forwards to the real callback with the chosen identity's `code`. The prototype found that a Playwright route on the provider's domain never fires, because only the first request in a redirect chain is routed, and that Chromium does not follow a 302 returned by `route.fulfill` for a navigation. So the page is an HTML 200, not a redirect.
  - **Playwright:** the journey picks an identity with a query parameter or cookie on the start link. A context route still aborts any request to a real provider host.
  - **Manual local dev:** the same page shows one button per identity.
  - The prototype did this in the browser, inside Playwright. The decided design moves the same technique into the fake module. This is the prototype's version of the page (from the prototype, trimmed; it is the technique, not the code to ship):

    ```js
    const r = await route.fetch({ maxRedirects: 0 });
    const u = new URL(r.headers()["location"]);
    const back = new URL(u.searchParams.get("redirect_uri"));
    back.searchParams.set("code", `fake-${identity}`);
    back.searchParams.set("state", u.searchParams.get("state"));
    // keep the state Set-Cookie headers; answer 200 HTML that does location.replace(back), not a 302
    ```

    And, also from the prototype, the fail-closed rule that came out of the same run:

    ```js
    // match the decoded path, so /users/%40me is caught
    decodeURIComponent(url.pathname) === "/api/users/@me"
    // any other provider-host request: throw, never reach the real provider
    ```
- **Loading.** The fake lives outside the auth service's source tree and is loaded with `node --import` by the CI launcher and the local dev script. There is no extra port, no container and no change to the Playwright server configuration.
- **Hook mechanism.** The preload wraps Node's HTTP server, and the gateway source is unchanged. The fake module patches `http.createServer` before the gateway loads, and wraps the request handler it's given. It does two things. It serves its fake consent page at a reserved `/__fake-oauth/consent` path. And when a response is about to send a 302 whose `Location` is a configured provider host, it rewrites that `Location` to its consent page, carrying the original query (`state`, `redirect_uri`). Every other request and response passes through untouched. The shipped gateway has no extension point and never mentions the fake, so the guardrail test holds.
- **Three guards against shipping it.**
  1. It lives outside the compiled source tree. The auth image compiles only that tree and installs with development dependencies omitted, so the fake and msw are absent from the image.
  2. A guardrail test fails if anything in the shipped auth source imports it.
  3. It refuses to load unless `PUBLIC_ORIGIN` is a loopback address (`localhost`, `127.0.0.1` or `[::1]`). The research note also allowed a `.test` host. The resolution says loopback only, and this spec follows the resolution.

  It does not depend on `NODE_ENV`, because the deployment compose file defaults that to `development`.
- **Email codes in tests.** Until the fake lands, local development and CI set `EMAIL_SIGN_IN=on` so the existing email-code journeys keep working. After it lands, only the tests that cover email-code sign-in set it on.
- **A new provider** needs a fake entry for its token and profile endpoints, which is test configuration only.

### Launch checklist: provider consoles (owner work)

Registering real credentials is launch work, not a design decision. The `providerSignInVerified` gate requires it.

For each environment (local, staging if any, production), register this exact redirect URI: `${PUBLIC_ORIGIN}/api/auth/callback/<id>`, where `<id>` is `google` or `discord`. Local examples are `http://localhost:5173/api/auth/callback/google` and `.../discord`. Use the browser at the host `PUBLIC_ORIGIN` names. Each distinct local port is a distinct redirect URI, so automated tests use the fake, not real credentials.

- **Google (Google Auth Platform)**
  - [ ] Create an External project and an OAuth client of type web application.
  - [ ] Add the redirect URI for each environment exactly: scheme, case and trailing slash must match. HTTPS is required except on localhost.
  - [ ] Request only the basic scopes `openid`, `email` and `profile`. They are non-sensitive, so app verification is not needed.
  - [ ] In Testing status, at most 100 listed test users can sign in, and each consent expires after seven days. Publish to production before opening signup beyond that.
  - [ ] Brand verification (app name and logo on the consent screen) is optional and not a launch gate. It needs a verified domain in Search Console, a public homepage and a privacy policy on the same domain.
  - [ ] Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in the environment.
- **Discord**
  - [ ] Create an application and add the redirect URI for each environment exactly.
  - [ ] Use the scopes `identify` and `email`. The research found no primary source requiring review or a user cap for a login-only app, so confirm in the Developer Portal that no review applies.
  - [ ] Set `DISCORD_CLIENT_ID` and `DISCORD_CLIENT_SECRET`.
- **Then**
  - [ ] Sign in with each provider on the production origin, record the proof, and list the provider ids in `providerSignInVerified`.
  - [ ] Keep `SIGNUP_MODE=owner-only` until the owner chooses to open signup with a version 2 proof.
- **Order on the deployed stack.** With `EMAIL_SIGN_IN` off by default and no credentials yet, the deployed owner-only stack has no sign-in method. Register credentials and complete the owner's first Google or Discord link before that stack runs with email off, or keep `EMAIL_SIGN_IN=on` there until then. A production-only startup refusal for "no sign-in method" would not protect the deployed stack, because the deployment compose file defaults `NODE_ENV` to `development`. The refusal must therefore not depend on `NODE_ENV`, or the order above is the safeguard.

## Testing Decisions

A good test checks behaviour that a collector, operator or caller can observe: a status code, a redirect, a cookie, a row's presence or absence, a page's visible message. It does not assert helper names, Better Auth internals, SQL spelling or the shape of fake internals. Tests that touch the gate prove outcomes (what was created, refused or linked), not which hook ran.

The owner confirmed three seams.

### 1. The gateway HTTP surface (primary seam)

This follows the existing gateway HTTP tests in `auth/tests`: the live Better Auth boundary test, which spawns the real gateway against real Postgres, and the signup tests, which start a gateway with its own database and `SIGNUP_MODE` through environment variables. The new tests load the OAuth fake through the launcher and walk start, fake consent and callback over plain HTTP, reading the redirect and cookies as a browser would. They cover:

- **Linking.** The owner's first Google sign-in reaches the existing owner account and data. A Discord sign-in at the same verified email links to it. Name and picture are filled on the first link and updated on a later sign-in. A returning sign-in with a changed provider email still reaches the same collector. A local account with an unverified email is not linked.
- **Gates.** Each `SIGNUP_MODE` by action (create, link, sign in), for the owner and for non-owners. Owner-only refuses a non-owner with `sign_in_unavailable`, identically whether or not the email matches an existing collector. An unverified or missing provider email is refused and leaves no user, Unsorted root or account row. Creation at `OWNER_EMAIL` on a fresh deployment works.
- **Email-code switch.** With `EMAIL_SIGN_IN=off`, the gateway email-code routes return 404 and Better Auth refuses the plugin endpoints. With it on, email-code sign-in still works, including creating the owner account, and the gate does not break it. Assert only that sign-in succeeds, not what the verified flag holds at that moment.
- **Approval codes with email off.** The owner can still request an approval code and spend it, and operations mail still sends.
- **Routes.** An unknown provider returns 404 on the start, callback and link routes. Unlisted `/api/auth/*` paths return 404 and never reach the API. Unsafe `next` values (`//host`, `/\host`, `/api/...`, `/auth/...`, a full URL) fall back to `/collection`. The callback relays `Location` and `Set-Cookie`. `GET /auth/methods` reflects the configured providers and the email switch, and reveals nothing about accounts.
- **Limits.** The per-IP and app-wide creation limits at their boundaries. Returning sign-ins are not throttled. A missing IP context refuses creation. The start limit at 60 per hour. Pruning of old rows. A refusal increments the auth counter. The owner panel shows new accounts in the last day against `DAILY_SIGNUP_CAP` and warns at 80%, and not below it.
- **Settings routes.** Listing, linking and unlinking. An unknown provider, a stale session for link and for unlink, an account owned by another collector, an unverified provider email, a different but verified email, unlinking the last sign-in, and the origin check on unlink.
- **Null tokens.** After create, link and a repeat sign-in, the stored access, refresh and ID tokens and both expiries are null.
- **Profile.** `/auth/session` returns name and image only for the signed-in collector, and Published Deck and Discover responses contain no name, picture or email.
- **Readiness proof v2.** Extend the existing signup tests: version 1 rejected, a missing or short `providerSignInVerified` rejected, mail checks required only with email sign-in on, and `MAIL_MODE=http` required only then.

Practical notes:

- Existing tests clear `auth_send_event` directly in setup. The new limits need the same reset: tests that sign in many times from one loopback IP clear `auth_rate_event` and the start-limit rows directly. Do not add a bypass setting to production code.
- The browser journeys will move about 145 sign-in call sites across 21 specs to OAuth starts from one address. That can exceed 60 starts per hour and, in `local-public` tests, 10 creations per day, so the shared sign-in helper must reset these limits.
- Owner bootstrap: before any owner binding exists, the verified `OWNER_EMAIL` user can create, sign in and link. Once bound, only the bound user can, even if `OWNER_EMAIL` changes. Tests cover both states.

### 2. Browser journeys

The existing browser journeys move from email codes to owner sign-in through the fake consent page, through one shared sign-in helper, using the owner identity at `OWNER_EMAIL`. Email codes stay off for them. One new journey covers the failure messages and the Sign-ins page: cancel, unverified email, not-open-yet, too many attempts, the Sign-ins page list, connect, remove, the hidden Remove for the last sign-in, a refused account owned by someone else, and the stale-session path. It asserts for each group the mapped message, that an unknown code shows "Didn't complete", that `error_description` is never rendered, and that the code is removed from the address bar after display. It also checks that the message is announced as an alert and takes focus once. The prior art is the existing Playwright specs and their per-worker stack support. Mobile layout is checked in the mobile journey.

### 3. Guardrails

- The fake's own tests: every identity resolves, an unknown provider call throws, a non-loopback `PUBLIC_ORIGIN` is refused, and the decoded `users/@me` path is matched.
- A test that the shipped auth source never imports the fake or its dependencies, with positive and negative examples, alongside the existing guardrail checks that run in the gate.

### Ordering

Until the fake lands, local development and CI keep `EMAIL_SIGN_IN=on`. After it lands, only the email-code tests turn it on. Both orderings must pass the gate.

## Out of Scope

From the [map](wayfinder/map.md):

- Apple, GitHub and other providers. Adding one later must stay cheap.
- Passwords.
- Removing email-code sign-in or owner approval codes.
- Changing how operations mail works.
- Changing session length or cookie rules.
- The sign-in screen's visual layout, owned by the app-redesign map.

Also not in this effort: profile editing, account deletion, copying provider pictures into PrizeCheck storage, and a content-security policy (noted only so a later one allows the image hosts).

## Further Notes

### Sources

- [OAuth sign-in decision map](wayfinder/map.md)
- Research: [Google and Discord sign-in under Better Auth](wayfinder/research/google-discord-better-auth.md), [Running OAuth sign-in locally and in CI](wayfinder/research/oauth-local-and-ci.md)
- Resolutions:
  - [How a sign-in links to an existing account](wayfinder/resolutions/decide-sign-in-linking.md)
  - [How the gateway exposes OAuth sign-in routes](wayfinder/resolutions/decide-gateway-oauth-routes.md)
  - [The gates for OAuth signup and hidden email sign-in](wayfinder/resolutions/decide-signup-and-email-gates.md)
  - [Which provider profile data to keep](wayfinder/resolutions/decide-provider-profile-data.md)
  - [How local dev and CI fake provider sign-in](wayfinder/resolutions/decide-oauth-test-fake.md)
  - [How the sign-in settings page behaves](wayfinder/resolutions/decide-sign-in-settings-page.md)
  - [What the sign-in page says when sign-in fails](wayfinder/resolutions/decide-sign-in-failure-messages.md)
  - [Limits on OAuth account creation](wayfinder/resolutions/decide-oauth-signup-limits.md)
- Existing sign-in, privacy and logging requirements: [MVP spec](../tcg-collection-tracker/spec.md), Authentication, hosting, and operations.

### Decision traceability

| Resolution | Issue | Spec sections |
| --- | --- | --- |
| Linking | [#131](https://github.com/ry-cen/prizecheck/issues/131) | Better Auth configuration, The signup gate, stories 14 to 30 |
| Gateway routes | [#135](https://github.com/ry-cen/prizecheck/issues/135) | Gateway route contract, stories 51 to 57 |
| Signup and email gates | [#132](https://github.com/ry-cen/prizecheck/issues/132) | The signup gate, Readiness proof version 2, stories 31 to 50 |
| Profile data | [#133](https://github.com/ry-cen/prizecheck/issues/133) | Profile and `/auth/session`, stories 58 to 66 |
| Test fake | [#134](https://github.com/ry-cen/prizecheck/issues/134) | Test fake, Testing Decisions, stories 96 to 104 |
| Settings page | [#143](https://github.com/ry-cen/prizecheck/issues/143) | Gateway route contract, Web pages, stories 67 to 80 |
| Failure messages | [#144](https://github.com/ry-cen/prizecheck/issues/144) | Failure messages, stories 81 to 86 |
| Creation limits | [#145](https://github.com/ry-cen/prizecheck/issues/145) | Account creation limits, stories 87 to 95 |
| Research (providers) | [#129](https://github.com/ry-cen/prizecheck/issues/129) | Better Auth configuration, launch checklist |
| Research (local and CI) | [#130](https://github.com/ry-cen/prizecheck/issues/130) | Test fake |

Implementation tickets do not exist yet. They come from the owner running `/to-ticket` on this spec.

### Dependency on the app-redesign map

The sign-in screen layout, the Sign-ins page placement and the exact copy for every message belong to the app-redesign map's "Sign-in and loading screens" work. That map lives on the `feature/app-redesign` branch and is not in this worktree, so it is named here without a link. This spec fixes which controls exist and how they behave; the redesign fixes how they look and read. `/collection` as the default destination also comes from that map.

### Details settled at publication

The owner delegated technical choices. These gaps were left by the resolutions and were settled when the spec was published on 2026-10-12.

1. **Owner bootstrap under `owner-only`.** If no owner binding exists yet, the gate treats the user whose verified email is `OWNER_EMAIL` as the owner for creating, signing in and linking. Once `bind_owner` has run, only the bound user counts. The binding step itself is unchanged.
2. **Start-limit storage.** One table, `auth_rate_event(kind, ip_key, created_at)`, holds both the `signup` and `start` limits. It's pruned of rows older than two days whenever rows are written.
3. **Refusal codes.**
   - `sign_in_unavailable` is the owner-only refusal. `signup_disabled` maps to the same "Not open yet" message.
   - `recent_sign_in_required` is the stale-session refusal. The unlink route returns it with 403.
   - Unlinking the last sign-in returns 400 with Better Auth's `FAILED_TO_UNLINK_LAST_ACCOUNT`, shown as "Didn't complete". The page never offers that action anyway.
4. **Route count.** The gateway resolution's "exactly two new routes" means the sign-in flow. `/auth/methods` and the three Sign-ins routes come from later resolutions and follow the same rules.
5. **Fake hook and owner panel.** See "Hook mechanism" under the test fake and "Owner panel data path" under modules.
6. **The proposals in the body are accepted:**
   - the `/auth/methods` body;
   - the collector's email in `/auth/session`;
   - startup errors for a half-configured provider, an invalid `EMAIL_SIGN_IN` value, or no sign-in method (not tied to `NODE_ENV`);
   - an over-limit start redirected with `error=too_many_sign_ups`;
   - email-code creation not counting toward the creation limits;
   - the extra fake identities.
7. **Documents left as they are.** The MVP spec's public-signup story and gate are superseded by readiness proof version 2 for OAuth-only deployments. ADR 0002 stays as it is, because OAuth is additive and email codes remain in the stack. No new `CONTEXT.md` terms: sign-in methods are auth mechanics, not collection-domain language.

### Rollout order

1. Raise the Better Auth range and add the schema migration.
2. Build the gate, token hooks, provider list and gateway routes behind `EMAIL_SIGN_IN=on` in CI.
3. Land the test fake, then move CI and the journeys to OAuth sign-in and turn email sign-in off by default.
4. Add the Sign-ins page and failure messages, then the limits and owner panel.
5. Do the launch checklist and record the readiness proof only when the owner decides to open signup.
