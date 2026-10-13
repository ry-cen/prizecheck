# Decide how the gateway exposes OAuth sign-in routes

Resolved 2026-10-12 for [Decide how the gateway exposes OAuth sign-in routes](https://github.com/ry-cen/prizecheck/issues/135). This is a technical choice the owner delegated to Claude. Facts come from [Google and Discord sign-in under Better Auth](../research/google-discord-better-auth.md), section 5, and from `auth/src/server.ts`.

## Today

The browser talks only to gateway-owned routes: `/auth/request-code`, `/auth/verify-code`, `/auth/session` and `/auth/sign-out`. These call Better Auth internally. Every `/api/*` path goes to FastAPI. Nothing exposes Better Auth's own endpoints, and `betterRequest()` and `relay()` drop the query string and `Location`.

## Decisions

1. **Explicit gateway routes, never a passthrough.** The gateway exposes exactly two new routes. Every other `/api/auth/*` path returns 404 from the gateway before the FastAPI branch, so Better Auth's other endpoints (email OTP included) can never be reached directly.
2. **Start route: `GET /auth/sign-in/:provider?next=<path>`.** This follows the existing `/auth/*` convention. A sign-in button is a plain link. The gateway calls Better Auth's social sign-in internally with `callbackURL` set to the checked `next`, and `errorCallbackURL` and `newUserCallbackURL` set to match. It answers with a 302 to the provider and Better Auth's `state` cookie. A GET start is safe here: it only begins a flow bound to the browser's own `state` cookie, and it ends on the person's own provider account.
3. **Callback route: `GET /api/auth/callback/:provider`.** This is Better Auth's default path and the exact redirect URI registered with each provider (`${PUBLIC_ORIGIN}/api/auth/callback/<id>`). The gateway matches it ahead of the `/api/*` branch and relays the request to Better Auth with its query string intact. It passes back the response's `Location` and `Set-Cookie`. Relaying `Location` applies to these OAuth routes only.
4. **Any configured provider, no hard-coded names.** `:provider` must be one of the providers configured at startup (from the env credentials). Anything else is a 404. A new provider needs no new gateway route.
5. **Errors land on the app's sign-in screen.** Better Auth's `onAPIError.errorURL` and each start's `errorCallbackURL` point at the web sign-in page with Better Auth's `error` code in the query, so `/api/auth/error` is never routed. The page's wording for each code belongs to the "Refused sign-in messaging" fog.
6. **The post-sign-in destination is a checked same-origin path.** The gateway accepts `next` only if it starts with a single `/`, isn't `//…` or `/\…`, and doesn't point into `/api/` or `/auth/`. Otherwise it uses `/collection`, the default page after sign-in from the app-redesign map. Better Auth's `trustedOrigins` check on `callbackURL` stays on as a second layer.
7. **Linking and unlinking routes come later.** The settings page's routes are decided in [Decide how the sign-in settings page behaves](https://github.com/ry-cen/prizecheck/issues/143), following the same rules: explicit gateway routes, any configured provider, checked destinations.
8. **Turning off email sign-in at Better Auth itself is out of this ticket.** Whether to also list the email-OTP endpoints in Better Auth's `disabledPaths` is part of the switch in [Decide the gates for OAuth signup and hidden email sign-in](https://github.com/ry-cen/prizecheck/issues/132). Decision 1 already makes them unreachable from outside.

## Consequences for the spec

- `betterRequest()` must forward the query string. `relay()` must pass `Location` for the OAuth routes.
- The callback uses the shared pool. It isn't a budgeted route.
- The web sign-in page needs to read an `error` query parameter, and to send `next` when a protected route sends someone to sign in.
- Gateway tests cover:
  - an unknown provider returns 404;
  - unlisted `/api/auth/*` paths return 404 and never reach FastAPI;
  - unsafe `next` values fall back to `/collection`;
  - the callback relays `Location` and `Set-Cookie`.
