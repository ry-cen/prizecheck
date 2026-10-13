# Research: running OAuth sign-in locally and in CI (as of 2026-10-12)

**Label:** wayfinder:research
**Ticket:** [#130 Research running OAuth sign-in locally and in CI](https://github.com/ry-cen/prizecheck/issues/130)
**Researched:** 2026-10-12

## Question

How can local development and CI exercise Google and Discord sign-in without real provider accounts? Compare mock OIDC/OAuth servers, Better Auth's test utilities or a test-only provider, and stubbing at the gateway. For each option, cover:

- fidelity to the real redirect flow;
- setup cost;
- CI fit;
- how it plugs into the browser harness and the existing `MAIL_MODE=file` style of fake;
- how to guarantee the fake can never run in production.

## Short answer

- **Better Auth's built-in `google()` and `discord()` providers hard-code their token and profile URLs.** Only the browser-facing `authorizationEndpoint` can be overridden (B1, B2, B3). So no mock server can stand in for Google or Discord through configuration alone while the real provider code still runs. Each option makes one of three choices:
  - intercept the server-to-server calls inside the auth process, which keeps the real provider code;
  - replace the providers with `genericOAuth` entries that use the same ids, which drops the real provider code;
  - skip OAuth entirely, which drops the callback.
- **Better Auth tests its own social providers the first way.** Its `social.test.ts` uses `oauth2-mock-server` together with `msw`, which intercepts `https://oauth2.googleapis.com/token` in-process (B6). Both are dev dependencies of `better-auth` 1.7.6 (B7).
- **The callback doesn't reach Better Auth today, whichever option is chosen.** The gateway sends every `/api/*` path to FastAPI (R1), and Vite proxies `/api` to the gateway (R4). So Better Auth's default redirect URI, `${PUBLIC_ORIGIN}/api/auth/callback/<id>`, currently lands on the Python API. Every option needs a gateway route for the sign-in start and the callback. The fake must be given that same redirect URI.
- **There is no Playwright `webServer`.** `scripts/ci.sh` `start_stack` launches the api, auth and web processes for each browser stack. Ports come from `verify.py` and `verify_resources.py`, and Playwright receives them through `VERIFY_BROWSER_STACKS` (R2, R3). A fake plugs in there, not in `playwright.config.ts`.
- **A `NODE_ENV=production` guard like the `MAIL_MODE` one isn't enough.** `compose.deploy.yml` defaults `NODE_ENV` to `development` for the deployed Unraid dev stack (R5), so that stack would pass such a check. Safer, structural guarantees exist (see "Production guarantee").
- **Lean, not a decision:** keep the real `google()` and `discord()` providers. Fake the browser side with a fake consent page served through Playwright `context.route` (or a tiny local page for manual dev). Fake the server side with `msw` handlers for the provider token and profile URLs, loaded only by the test and dev launcher through `node --import`. External mock IdPs (navikt, Dex, oauth2-mock-server) add a process and still can't answer at `discord.com` or `googleapis.com` without the same interception. Details and alternatives are below.

## Sources

| Ref | Source | Kind |
|-----|--------|------|
| B1 | [`packages/core/src/social-providers/google.ts` @ v1.7.6](https://github.com/better-auth/better-auth/blob/v1.7.6/packages/core/src/social-providers/google.ts) | Primary (library source) |
| B2 | [`packages/core/src/social-providers/discord.ts` @ v1.7.6](https://github.com/better-auth/better-auth/blob/v1.7.6/packages/core/src/social-providers/discord.ts) | Primary |
| B3 | [`packages/core/src/oauth2/oauth-provider.ts` @ v1.7.6](https://github.com/better-auth/better-auth/blob/v1.7.6/packages/core/src/oauth2/oauth-provider.ts) (`ProviderOptions`), [`create-authorization-url.ts`](https://github.com/better-auth/better-auth/blob/v1.7.6/packages/core/src/oauth2/create-authorization-url.ts), [`validate-authorization-code.ts`](https://github.com/better-auth/better-auth/blob/v1.7.6/packages/core/src/oauth2/validate-authorization-code.ts) | Primary |
| B4 | [`packages/better-auth/src/api/routes/callback.ts` @ v1.7.6](https://github.com/better-auth/better-auth/blob/v1.7.6/packages/better-auth/src/api/routes/callback.ts) | Primary |
| B5 | [`packages/better-auth/src/plugins/generic-oauth/` @ v1.7.6](https://github.com/better-auth/better-auth/tree/v1.7.6/packages/better-auth/src/plugins/generic-oauth) (`index.ts`, `types.ts`) | Primary |
| B6 | [`packages/better-auth/src/social.test.ts` @ v1.7.6](https://github.com/better-auth/better-auth/blob/v1.7.6/packages/better-auth/src/social.test.ts), lines 14–116 (msw + OAuth2Server setup) | Primary (library tests) |
| B7 | `better-auth` 1.7.6 `package.json` devDependencies: `msw ^2.14.6` and `oauth2-mock-server ^9.0.0`. Read from the installed package. | Primary |
| B8 | `better-auth/plugins` `testUtils` (`dist/plugins/test-utils/index.d.mts`, 1.7.6) | Primary |
| N1 | [navikt/mock-oauth2-server README](https://github.com/navikt/mock-oauth2-server). Latest release 6.0.6 (2026-10-12). | Primary |
| A1 | [axa-group/oauth2-mock-server README](https://github.com/axa-group/oauth2-mock-server). Latest release v9.2.0 (2026-09-04); `engines.node ^22.12 \|\| ^24 \|\| ^26` (npm registry). | Primary |
| D1 | [Dex local connector docs](https://dexidp.io/docs/connectors/local/), [`examples/config-dev.yaml`](https://github.com/dexidp/dex/blob/master/examples/config-dev.yaml), [`connector/mock/connectortest.go`](https://github.com/dexidp/dex/blob/master/connector/mock/connectortest.go). Latest release v2.46.0. | Primary |
| M1 | [MSW Node.js integration](https://mswjs.io/docs/integrations/node) (`setupServer` from `msw/node`). Current npm version 3.0.3; Better Auth itself uses ^2.14. | Primary |
| P1 | Playwright [`BrowserContext.route`](https://playwright.dev/docs/api/class-browsercontext#browser-context-route) and [`Route.fulfill`](https://playwright.dev/docs/api/class-route) | Primary |
| R1 | `auth/src/server.ts`: `/api/` branch proxies to `apiOrigin` (line 16, line 514); 404 fallthrough at line 565 | Repo |
| R2 | `scripts/ci.sh` `start_stack` (`node --import tsx auth/src/server.ts`), `MAIL_MODE=file` export | Repo |
| R3 | `scripts/verify_resources.py` `STACK_KEYS`; `web/tests/support/browser-stack.ts`; `playwright.config.ts` (no `webServer`) | Repo |
| R4 | `web/vite.config.ts` proxies `/auth` and `/api` to `AUTH_PORT` | Repo |
| R5 | `compose.deploy.yml` lines 29 and 91 (`NODE_ENV: ${PRIZECHECK_NODE_ENV:-development}`), line 92 (`MAIL_MODE: ${MAIL_MODE:-file}`) | Repo |
| R6 | `deploy/docker/auth.Dockerfile`: compiles only `auth/src` (`--rootDir auth/src`) and installs runtime deps with `npm ci --omit=dev` | Repo |
| R7 | `auth/src/auth.ts`: `MAIL_MODE` guard (throws under `NODE_ENV=production`), loopback-only `http:` relay check | Repo |
| R8 | `package-lock.json`: `better-auth` and `@better-auth/core` resolve to **1.7.6**, although `package.json` says `^1.4.0` | Repo |

## Findings

### 1. What the real providers let you override (Better Auth 1.7.6)

The map says "Better Auth 1.4". The lockfile actually installs 1.7.6 (R8), and everything below is from 1.7.6.

- **Authorization endpoint (browser redirect): overridable.** `ProviderOptions.authorizationEndpoint` is documented as "Useful for testing with local OAuth servers" (B3). `createAuthorizationURL` uses `options.authorizationEndpoint || authorizationEndpoint` (B3).
- **Token endpoint (server-to-server): not overridable.** `google()` passes the literal `https://oauth2.googleapis.com/token`, and `discord()` passes `https://discord.com/api/oauth2/token` (B1, B2). `ProviderOptions` has no `tokenEndpoint` field (B3).
- **Profile: overridable only by replacing the provider's own code.** `options.getUserInfo` replaces the whole profile step (B3).
  - Discord otherwise fetches `https://discord.com/api/users/@me` (B2).
  - Google otherwise decodes the `id_token` from the token response with `decodeJwt`, which does **no signature check** on the callback path. It relies on TLS to Google's token endpoint (B1). There's no nonce either:
    - The callback generates and passes an id-token nonce only when `provider.requiresIdTokenNonce` is set (`generateIdTokenNonce` in `oauth2/state`; B4 passes `expectedIdTokenNonce`).
    - Neither `google()` nor `discord()` sets that field, and Google's `getUserInfo` ignores `expectedIdTokenNonce` (B1, B2).
    - The callback's `iss` check applies only when the provider has a top-level `issuer`, and `google()` has none. Its issuer list sits under `idToken` (B1, B4).
    - So a fake `id_token` needs only plausible claims, not a Google-trusted key. Signature verification (`jwks` from `googleapis.com/oauth2/v3/certs`) applies only to the id-token sign-in path, which `disableIdTokenSignIn` can switch off (B1, B3).
- **Callback sequence (B4).** It runs in this order:
  1. `parseState` checks the state cookie and recovers the PKCE `codeVerifier`.
  2. `provider.validateAuthorizationCode` exchanges the code.
  3. `provider.getUserInfo` reads the profile.
  4. Better Auth creates or links the user and account, then issues the session.

  Any fake that enters at step 2 or 3 still runs the state, PKCE, linking and session code. Those are the parts this map's decisions depend on: email-match linking to the owner, and the `SIGNUP_MODE` gate.
- **Provider-specific details a fake must reproduce (B1, B2).**
  - Google always sends PKCE (`codeVerifier is required for Google`) and reads `sub`, `email`, `email_verified`, `name` and `picture` from the id token.
  - Discord defaults to `prompt=none` and maps `global_name || username`, `email` and `verified` to `emailVerified`. When `avatar` is null it calls `BigInt(profile.id)`, so a fake Discord profile must have a numeric snowflake `id`.

### 2. How the callback reaches Better Auth here (applies to every option)

- **Better Auth is configured with `basePath: "/api/auth"`, so its redirect URI is `${PUBLIC_ORIGIN}/api/auth/callback/<id>`** (B4 builds the path; `auth/src/auth.ts` sets the base).
- **The gateway never forwards `/api/auth/*` to Better Auth.** It wraps Better Auth in its own `/auth/*` routes, which call `auth.handler(...)` internally. Every other `/api/*` path is proxied to FastAPI (R1).
- **Every option therefore needs gateway routes.** One starts the social sign-in, and one passes the callback to `auth.handler`. The gateway's owner-only check belongs at those routes too (map note).
- **The fake's redirect target must match whichever path is chosen.** Local stacks reach the gateway through Vite (R4) and deployed stacks through nginx.

### 3. How a fake plugs into the harness

- **`playwright.config.ts` has no `webServer` block, and none should be added for this** (R3).
- **`scripts/ci.sh` `start_stack` starts the stack processes.** It starts an api, auth and web process per browser stack, each from its own `env.sh`, and Playwright workers get their stack through `VERIFY_BROWSER_STACKS` (R2, R3).
- **A fake that lives in the auth process needs no new process, port or stack key.** It only adds one `--import` to the auth launch line.
- **A separate mock IdP process needs more plumbing.** It needs a `start_stack` line and a port from `verify.py` (one per stack, or one shared), and probably a new `STACK_KEYS` entry. It also needs a readiness wait in `wait_for_stack`. As Docker, it has to run on the developer's host during `npm run verify` with parallel stacks, not only as a GitHub `services:` container.
- **The `MAIL_MODE=file` analogue.** Today `ci.sh` exports `MAIL_MODE=file` and specs read `MAIL_FILE` (R2). The equivalent for OAuth is a test-identity choice. Each spec must pick who "signs in at Google":
  - the owner's address;
  - a stranger, for the refused path under owner-only;
  - an unverified email;
  - a cancelled consent, which redirects back with `error=access_denied`.

  Options differ most on how easily a test can choose that identity.

### 4. Options

#### A. Real providers, fake browser consent and in-process interception (msw)

- **How it works.**
  - Configure the real `socialProviders.google` and `socialProviders.discord`.
  - **Server side:** a test-support module, outside `auth/src`, calls msw `setupServer` (M1). It answers `POST oauth2.googleapis.com/token` with an `id_token` (any key, since the callback doesn't verify it, B1) and Discord's `POST /api/oauth2/token` and `GET /api/users/@me`. The launcher loads it with `node --import tsx --import ./auth/test-support/fake-oauth.ts auth/src/server.ts`. This is the same technique Better Auth uses in B6.
  - **Browser side, two choices:**
    1. Playwright `context.route('https://accounts.google.com/**')` and `('https://discord.com/api/oauth2/authorize**')` fulfill a small HTML "consent" page with one button per test identity. Each button navigates to the callback with `code` and the echoed `state` (P1). The fake encodes the chosen identity in `code`, so the msw token handler returns the matching profile. A `fulfill` returning 200 HTML is documented. Whether `fulfill` with a 302 is followed on a navigation isn't stated in the docs (P1), so the HTML page is the safer form.
    2. Set `authorizationEndpoint` to a loopback page served by the test-support module. This also works for manual local dev without Playwright, but it needs an option in `auth/src/auth.ts` (see "Production guarantee").
- **Fidelity: highest available without real accounts.**
  - These run for real: the provider classes, PKCE, state cookies, the provider's profile mapping (including Discord's `BigInt` path), the callback, linking and the session.
  - These are fake: Google and Discord's own pages and TLS.
- **Setup cost: low to moderate.**
  - One dev dependency (`msw`).
  - One test-support module of roughly 100 lines with handlers and fixture identities.
  - One `--import` flag in `ci.sh` (and in `dev:auth` if local dev uses it).
  - A Playwright helper for the consent page.
  - No Docker, no new port.
- **CI fit: npm only.** It runs inside the existing auth process on the host and in GitHub Actions alike.
- **Adding a provider stays cheap.** Each new provider needs one msw handler set, one route pattern and fixture identities.
- **Risk.**
  - msw patches Node's global `fetch` for the whole auth process. That is intended here, but the handlers must use `onUnhandledRequest: "bypass"` so DB and API calls are untouched (B6 does this).
  - msw 3.x is current, while Better Auth's own tests use 2.x (M1, B7). Pin the version.

#### B. External mock IdP process (navikt mock-oauth2-server, oauth2-mock-server, Dex)

- **What each one offers.**
  - **navikt** (N1): Docker `ghcr.io/navikt/mock-oauth2-server:<ver>`, port 8080 (`SERVER_PORT`). Any first path segment becomes its own issuer, so `/google` and `/discord` need no config. It has an interactive login form on `/authorize` (on by default in standalone mode) that posts `username` and optional `claims` JSON, and Playwright can fill it. Claims are templated through `JSON_CONFIG` `tokenCallbacks`, and it serves `/{issuer}/userinfo`. No npm package.
  - **oauth2-mock-server** (A1): npm, needs Node ^22.12. `/authorize` redirects straight back with a code and has **no login UI**. Identity per test comes from `BeforeTokenSigning` and `BeforeUserinfo` hooks, through its programmatic API in the same Node process that starts it. It supports PKCE. Its README warns it "is not intended to be used as an actual production grade OAuth 2 server".
  - **Dex** (D1): Docker. The `mockCallback` connector always returns one fixed user, Kilgore Trout (`kilgore@kilgore.trout`, `EmailVerified: true`). That identity can't be set to `OWNER_EMAIL`. `staticPasswords` (bcrypt hashes in YAML) gives fixed users with a login form. It's the heaviest of the three, and it's built to federate rather than to fake.
- **The problem with the real providers.** With built-in `google()` and `discord()`, only the authorize redirect can point at the mock. The code exchange still goes to `oauth2.googleapis.com` and `discord.com` (§1). So a mock server works only in one of two ways:
  - **(B-i) alongside option A's interception.** msw forwards those URLs to the mock. That adds a process and gains only navikt's login form.
  - **(B-ii) behind genericOAuth entries** (option C).
- **Discord doesn't fit an OIDC mock well.** Discord is plain OAuth2 with a custom `/users/@me`. An OIDC mock's `/userinfo` returns `sub` and so on, not Discord's `id`, `global_name` and `verified`, unless a hook rewrites it (A1 `BeforeUserinfo`; N1 claims templating).
- **CI fit.**
  - navikt and Dex: Docker. On the host that means one container per verify run, with a port from `verify.py`. In GitHub Actions it can be a `services:` container, but local `npm run verify` needs the same container.
  - oauth2-mock-server: an npm process, or in-process.
- **Setup cost: moderate to high.** A process lifecycle in `start_stack` and `wait_for_stack`, port allocation, and config files on top of whatever option A or C still requires.

#### C. `genericOAuth` entries shadowing `google` and `discord`, pointed at a mock, in test mode only

- **How it works.** genericOAuth registers providers that use the same `signIn.social` and `/callback/:id` endpoints as built-in providers. If a `providerId` matches a built-in, it is placed first, with a logged warning: "shadows a built-in social provider" (B5).
  - In test mode, register `{ providerId: "google", discoveryUrl: <mock>/google/.well-known/openid-configuration, ... }` and the same for Discord.
  - The account rows still say `providerId = "google"`, and the redirect URI path is unchanged.
- **Fidelity: medium.**
  - The callback, state, PKCE (`pkce` option), linking, gating and session are real.
  - The **provider adapter is not.** genericOAuth's own token exchange and profile mapping (`email`, `email_verified`, `picture`, `name` from userinfo or id token, B5) run instead of `google.ts` and `discord.ts`. Bugs in Discord's mapping (`global_name`, `verified`) or Google's `id_token`-only profile path would not show up.
  - Production and test would run different provider code.
- **Setup cost.** A mock IdP from option B is still needed, plus a branch in `auth/src/auth.ts` that swaps provider config by environment. That puts test-only code in the production module.
- **CI fit.** Inherits whichever mock it uses.

#### D. A test-only provider (gated like `MAIL_MODE`)

- **How it works.** Add a third provider id (for example `fake`) through genericOAuth or a hand-written `OAuthProvider`, enabled by something like `OAUTH_MODE=fake`, with a guard modelled on R7.
- **Fidelity: low to medium.** It exercises the callback and linking, but under a different provider id. So "Google sign-in reaches the owner's account" isn't actually tested.
  - That conflicts with the map's need to prove the owner can move over by email match through Google and Discord specifically.
  - The sign-in buttons under test would also differ from production's.
- **Setup cost: low.**
- **Production risk: highest of the OAuth-shaped options.** The fake provider's code ships in the image (it lives in `auth/src`), and a single environment variable turns it on (see "Production guarantee").

#### E. Stub at the gateway or with `testUtils`

- **How it works.** A test-only gateway route mints a session for a chosen email, or tests use `testUtils().login({ userId })` (B8).
- **Fidelity: lowest.**
  - It skips the redirect, state, PKCE, the provider callback, account creation and linking, and the `SIGNUP_MODE` gate on the OAuth path.
  - Those are exactly the decisions this map has to verify.
  - B8's own docs say `testUtils` "expose[s] privileged helpers" and recommend a separate test-only auth instance, not the production config.
- **Use.** It's fine as a speed-up for specs that only need to be signed in, the way some specs may already shortcut OTP. It's not acceptable as the OAuth journey test.
- **Setup cost: lowest.**

### 5. Comparison

| Option | Real `google.ts` / `discord.ts` run? | Real callback, linking and gate run? | Per-test identity | Extra process | CI fit | Cost to add a provider |
|---|---|---|---|---|---|---|
| A. msw + fake consent page | Yes | Yes | Easy (encoded in fake `code`) | None | npm, in-process | Handlers + route pattern |
| B-i. Mock IdP + msw forwarding | Yes | Yes | navikt: login form; oauth2-mock-server: hooks; Dex: fixed users | One (Docker or Node) | Docker on host + Actions, or npm | Mock config + handlers |
| C. genericOAuth shadowing + mock | No (generic adapter) | Yes | Same as the mock used | One | As the mock | Config entry |
| D. Test-only `fake` provider | No (different id) | Partly (different provider id) | Easy | Optional | npm | N/A (doesn't test the new provider) |
| E. Gateway or `testUtils` session | No | No | Trivial | None | npm | N/A |

### 6. Production guarantee

**The `MAIL_MODE` pattern isn't enough on its own.** R7 throws only when `NODE_ENV === "production"`. But the deployed Unraid stack runs with `NODE_ENV` defaulting to `development` and `MAIL_MODE` defaulting to `file` (R5). That stack is reachable from the tailnet. A fake OAuth identity enabled there would let anyone who can reach the page sign in as the owner. Mechanisms that hold regardless of `NODE_ENV`:

1. **Keep the fake out of the image.**
   - `auth.Dockerfile` compiles only `auth/src` and installs `--omit=dev` (R6). A fake module outside `auth/src` (for example `auth/test-support/`) whose dependencies (`msw`, any mock server) are dev-only is physically absent from the production image.
   - It is loaded only by `ci.sh` and the local dev script through `node --import`, never imported from `auth/src`.
   - This is the strongest guarantee, and option A and B-i allow it.
2. **A guardrail check.** Have `scripts/check_guardrails.py` (or a vitest) fail if anything under `auth/src` imports `auth/test-support`, `msw` or a mock-server package. Add positive and negative examples in `tests/tooling`, as `docs/agents/verification.md` requires.
3. **Restrict any endpoint override in `auth/src` to loopback.** If `authorizationEndpoint` (option A, browser-side choice 2) or a discovery URL (C) is configurable, accept it only for `http://127.0.0.1`, `localhost` or `[::1]`. Also refuse it unless `PUBLIC_ORIGIN` is itself loopback. This mirrors the mail relay's loopback check in R7. A loopback authorize URL is useless to a remote attacker anyway, because their browser can't reach the mock.
4. **Self-check in the fake.** The test-support module refuses to install unless `PUBLIC_ORIGIN`'s host is loopback or ends in `.test`, so a mistaken `--import` on a deployed host fails at startup.
5. **For options C and D, the code ships in production,** so only guards 3 and 4 apply, and both are environment-dependent. That's a mark against them.

### 7. Lean

This is a reasoned lean, not a decision.

- **Option A for the journeys.**
  - It runs the real provider code that production runs.
  - It adds no process or port to `start_stack`.
  - It matches Better Auth's own testing technique (B6).
  - It allows the strongest production guarantee (§6.1).
  - It keeps adding a provider to "one handler set and one route pattern".
- **For browser-side consent, prefer Playwright `context.route` with an HTML consent page in the gate.** Separately decide whether manual local dev also needs a loopback consent page through a guarded `authorizationEndpoint` (§6.3). If it does, the test-support module can serve that page too.
- **Keep option E only as an optional shortcut** for specs where sign-in isn't the subject.
- **Consider navikt (B-i) only if a human-usable login form for manual dev becomes important.** It's the only mock with a ready-made interactive form and arbitrary claims, but it costs a Docker dependency in every local verify run.

**Open points for the decision ticket:**

1. The gateway routes and redirect URI path (§2).
2. Whether local manual dev uses the fake or real developer credentials.
3. Whether `--fast` and browser specs share one fixture-identity file with the API tests.
4. Prototyping that Playwright `route` reliably intercepts the cross-origin top-level navigation to `accounts.google.com` in this harness. Fulfilling with 200 HTML is documented (P1); the cross-origin navigation case was not verified here.
