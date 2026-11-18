# Native iOS sign-in: gateway side

Opt-in and nonprod only. A native app signs in through the existing web sign-in, a consent page and a one-time code, and receives a short-lived credential that can read the Collection (`GET /api/collection`) and nothing else. The iOS app side is in `NATIVE_SIGN_IN_IOS.md`.

## The switch

`NATIVE_SIGN_IN` controls the whole feature:

| Value                 | Effect                                                                                                     |
| --------------------- | ---------------------------------------------------------------------------------------------------------- |
| `on`                  | enables it                                                                                                 |
| unset, empty or `off` | disabled: every `/auth/native/*` route answers 404 and the `/api` proxy ignores `Authorization`, as before |
| anything else         | the gateway stops at startup                                                                               |

`on` together with `NODE_ENV=production` also stops the gateway at startup. Nothing in production configuration, provider settings, CORS or Better Auth `trustedOrigins` changes; there is no CORS header on any native route.

Migration `165_native_sign_in.sql` adds `native_grant` and `native_credential`, and two kinds for `auth_rate_event` (`native_approve`, 20 per trusted IP per hour; `native_token`, 30). Both tables stay empty while the switch is off.

## The flow

The callback is `prizecheck-native://auth/callback`. challenge and state are 43 base64url characters made on the device; the code and the token are 32 random bytes as 43 base64url characters. Every parameter appears exactly once, and no other parameter or fragment is accepted.

1. `GET /auth/native/start?challenge=C&state=S` (inside `ASWebAuthenticationSession`). Signed out, it lists one link per configured provider into the ordinary `/auth/sign-in/<id>` with `next` set to the approve page; signed in, it redirects to `/auth/native/approve`. The sign-in `next` check allows exactly this one `/auth/*` path, only while the switch is on.
2. `GET /auth/native/approve?challenge=C&state=S` shows "Allow the app to read your Collection?" with **Allow** and **Cancel**. It issues nothing. The form carries a stateless nonce bound to the web session, the challenge and the state (valid for 10 to 20 minutes).
3. `POST /auth/native/approve` (form, `Origin` must equal `PUBLIC_ORIGIN`, web session and nonce required) stores a grant for 60 seconds and answers `303` to `prizecheck-native://auth/callback?code=<code>&state=S`. Failures are HTML pages, never a redirect to the app.
4. `POST /auth/native/token` with `{"code","verifier"}` (JSON, at most 1 KiB, no `Cookie` or `Origin` header) deletes the grant only when `base64url(sha256(verifier))` matches the stored challenge, then issues `{"token","expires_at"}` valid for 24 hours. Issuing one also deletes credentials that expired or were revoked more than a day ago, in the same transaction. A wrong verifier burns nothing. Errors are `{"error":"invalid_request"}`, `{"error":"invalid_grant"}` or 429.
5. `GET /api/collection` with `Authorization: Bearer <token>` and no cookie is forwarded as that collector, signed like a cookie session. With the switch on, any other request that carries an `Authorization` header is `401 {"error":"Authentication required"}`; there is no fallback to the cookie.
6. `POST /auth/native/sign-out` with the bearer revokes that credential and always answers 204.

Every native HTML page carries `cache-control: no-store`, `referrer-policy: no-referrer`, `x-content-type-options: nosniff` and `content-security-policy: default-src 'none'; style-src 'unsafe-inline'; form-action 'self' prizecheck-native:; base-uri 'none'; frame-ancestors 'none'`. The `form-action` list names the app's callback scheme because CSP Level 3 applies `form-action` to the redirect that follows a form post: with `'self'` alone, WebKit or Chromium can block the `303` from `POST /auth/native/approve` to `prizecheck-native://auth/callback`. This replaces the `form-action 'self'` in the original brief; no other directive or header changed.

Only sha256 hashes of the code and the token are stored. Nothing logs a code, verifier, token, header or body.

## Known issue: consent POST Origin under `no-referrer`

The gateway's native pages send `referrer-policy: no-referrer`, so a real browser's consent form POST carries `Origin: null`, and the gateway's strict Origin check would reject it with 403. Proposed fix, not made: `same-origin`. It needs owner approval. The simulator stub (`mobile/native-fixture.mjs`) already uses `same-origin`.

## Run it locally against the OAuth fake

The OAuth fake (`auth/testing/oauth-fake`) answers for Google and Discord and refuses to load unless `PUBLIC_ORIGIN` is loopback. With a migrated disposable database (`python3 scripts/local_test_db.py doctor` and `docs/agents/local-testing.md` say how to get one):

```sh
export DATABASE_URL=<disposable database, already migrated with scripts/migrate.py>
NATIVE_SIGN_IN=on SIGNUP_MODE=local-public EMAIL_SIGN_IN=off NODE_ENV=development \
  PUBLIC_ORIGIN=http://127.0.0.1:3001 AUTH_PORT=3001 API_ORIGIN=http://127.0.0.1:8000 \
  OWNER_EMAIL=owner@example.test INTERNAL_AUTH_SECRET=local-secret BETTER_AUTH_SECRET=local-secret-2 \
  GOOGLE_CLIENT_ID=fake GOOGLE_CLIENT_SECRET=fake DISCORD_CLIENT_ID=fake DISCORD_CLIENT_SECRET=fake \
  node --import tsx --import ./auth/testing/oauth-fake/preload.ts auth/src/server.ts
```

The fake picks the account from `fake_identity` (for example `owner`). The automated version of this walk is `auth/tests/native-sign-in.test.ts`; run it with `npm run verify:local -- --burn-in --base HEAD`, or as part of `npm run verify:local -- --suite auth`.

Not for a real device: the app's gateway origin must be `https://` in a release build, and this slice never runs in production.

## Known limits before any production use

- **The gateway can't tell which app started a sign-in.** PKCE proves only that the code goes back to whoever started the flow, so anyone can start one, including by sending a collector a `/auth/native/start` link. The app's callback scheme, `prizecheck-native://`, is not registered by the app, so any app on the phone that claims the scheme receives the code after the collector taps **Allow**, and can exchange it with its own verifier. The consent page therefore says "the app" and never names Prizecheck. Before production, switch to an HTTPS callback that only this app can receive: `ASWebAuthenticationSession.Callback.https` with Universal Links, which need the owner's Apple team ID and an `apple-app-site-association` file. Also decide on app attestation.
- **Signing out on the web doesn't sign out the phone.** A native credential is separate from the web session. Web sign-out or revoking the web session leaves it valid for up to 24 hours. It ends only when the app signs out (`POST /auth/native/sign-out`), when it expires, or when the account is deleted, which cascades.
- **With the switch on, `Authorization` on `/api/*` means native.** Any `/api/*` request that carries an `Authorization` header, other than a valid native read of `GET /api/collection`, gets 401, including a web cookie request. A nonprod host behind HTTP Basic auth that passes the header through to the gateway breaks the web app while the switch is on, so strip the header at that proxy.
