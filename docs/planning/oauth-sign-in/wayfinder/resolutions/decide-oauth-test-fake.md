# Decide how local dev and CI fake provider sign-in

Resolved 2026-10-12 for [Decide how local dev and CI fake provider sign-in](https://github.com/ry-cen/prizecheck/issues/134). This is a technical choice the owner delegated to Claude, settled by a prototype. Sources: [OAuth sign-in locally and in CI](../research/oauth-local-and-ci.md) and the [prototype README](https://github.com/ry-cen/prizecheck/blob/prototype/oauth-fake/auth/prototypes/PROTOTYPE-oauth-fake/README.md) (on the throwaway `prototype/oauth-fake` branch).

## Decisions

1. **Keep the real Google and Discord provider code in every test.** Only the HTTP traffic to the providers is faked. That means PKCE, the profile mapping, linking, `validateUserInfo` and the gateway routes all run for real.
2. **The server side is faked in-process, loaded only by the test launcher.** A module outside `auth/src`, using msw or an equivalent fetch interceptor and installed as a dev dependency only, answers Google's token endpoint and Discord's token and `/users/@me` endpoints. It's loaded with `node --import` by `scripts/ci.sh` and the local dev script.
   - The `code` names a test identity: `owner` at `OWNER_EMAIL`, a new collector, an unverified email, a Discord account with no email, and a second owner provider account for linking.
   - Paths are decoded before matching, because Better Auth sends `/users/%40me`.
   - **Any other request to a provider host throws.** Nothing ever reaches a real provider.
3. **The browser side is faked by the same module, on our own start route.** A test-only fake consent page is served for `/auth/sign-in/:provider` when the fake is loaded. It stands in for the provider's page: it reads the `state` and `redirect_uri` from the real start response and forwards to the real callback with the chosen identity's `code`. The prototype found that a Playwright route on accounts.google.com never fires, because only the first request of a redirect chain is routed, and that Chromium won't follow a `302` returned by `route.fulfill`.
   - **Playwright:** the journey picks an identity with a query parameter or cookie on the start link. A context route still aborts any request to a real provider host.
   - **Manual local dev:** the same page shows one button per test identity, so a developer can sign in as owner, a new collector or an unverified account with no credentials.
4. **The fake can never ship. Three independent guards:**
   - It lives outside `auth/src`. The `auth` image compiles only `auth/src` and installs with `--omit=dev`.
   - A guardrail test fails if anything in `auth/src` imports it.
   - It refuses to load unless `PUBLIC_ORIGIN` is a loopback address.

   It doesn't depend on `NODE_ENV`, because `compose.deploy.yml` defaults that to `development`.
5. **Email codes stay off in tests once the fake lands.** Only the tests that cover email-code sign-in set `EMAIL_SIGN_IN=on` (see [Decide the gates for OAuth signup and hidden email sign-in](https://github.com/ry-cen/prizecheck/issues/132)). The existing browser journeys start with an OAuth sign-in as the owner identity.

## Consequences for the spec

- The fake is a test seam, built and reviewed like production code, with its own tests:
  - every identity resolves;
  - unknown provider calls throw;
  - it refuses a non-loopback origin.
- One `--import` flag is added to the launcher. There's no extra port, no Docker and no `webServer` change to `playwright.config.ts`.
- A new provider needs a fake entry for its token and profile endpoints, which is test configuration only.
