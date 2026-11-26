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

Migration `165_native_sign_in.sql` adds three tables, none of them web sign-in's: `native_grant`, `native_credential` and `native_rate_event` (the consent limit, 20 per trusted IP per hour, and the exchange limit, 30). It alters no existing table, and `auth_rate_event` is untouched. The tables stay empty while the switch is off.

## The flow

The callback is `prizecheck-native://auth/callback`. challenge and state are 43 base64url characters made on the device; the code and the token are 32 random bytes as 43 base64url characters. Every parameter appears exactly once, and no other parameter or fragment is accepted.

1. `GET /auth/native/start?challenge=C&state=S` (inside `ASWebAuthenticationSession`). Signed out, it lists one link per configured provider into the ordinary `/auth/sign-in/<id>` with `next` set to the approve page; signed in, it redirects to `/auth/native/approve`. The sign-in `next` check allows exactly this one `/auth/*` path, only while the switch is on.
2. `GET /auth/native/approve?challenge=C&state=S` shows "Allow the app to read your Collection?" with **Allow** and **Cancel**. It issues nothing. The form carries a stateless nonce bound to the web session, the challenge and the state (valid for 10 to 20 minutes).
3. `POST /auth/native/approve` (form, `Origin` must equal `PUBLIC_ORIGIN`, web session and nonce required) stores a grant for 60 seconds (the one `INSERT` is the commit point: see "What a 503 means") and answers `303` to `prizecheck-native://auth/callback?code=<code>&state=S`. Failures are HTML pages, never a redirect to the app.
4. `POST /auth/native/token` with `{"code","verifier"}` (JSON, at most 1 KiB, no `Cookie` or `Origin` header) deletes the grant only when `base64url(sha256(verifier))` matches the stored challenge, then issues `{"token","expires_at"}` valid for 24 hours. The swap is one transaction; the response deadline (2.5 s) and its `COMMIT` are decided at one point, immediately before the `COMMIT` is sent: after a deadline `503` nothing is committed, and once the `COMMIT` is sent the answer waits for its outcome. Issuing one also deletes credentials that expired or were revoked more than a day ago, in the same transaction. A wrong verifier burns nothing. Errors are `{"error":"invalid_request"}`, `{"error":"invalid_grant"}` or 429.
5. `GET /api/collection` with `Authorization: Bearer <token>` and no cookie is forwarded as that collector, signed like a cookie session. The app sends the target `/api/collection`, or `/api/collection?cursor=<value>` with one `cursor` (percent-encoded from letters, digits and `-._~`); nothing else is accepted, a bare `?` included. See "Authorization is decided first".
6. `POST /auth/native/sign-out` with exactly one well-formed bearer and no `Cookie` or `Origin` revokes that credential and answers `204` **only when that token is not usable any more**: revoked now, already revoked, expired, or never issued. It is idempotent and never `401`. A request that does not name one well-formed token (a cookie, an Origin, or a missing, duplicated or malformed bearer) is `400 {"error":"invalid_request"}`, so the phone cannot take an ignored request for a revocation. When the native database is busy or slow it answers `503 {"error":"Service temporarily unavailable"}` and the revocation is **unconfirmed**: send it again. The app does (see "Sign-out is durable on the phone, with these limits").

## What a 503 means

Consent (`POST /auth/native/approve`) and the code exchange (`POST /auth/native/token`) answer `503` when the native database is busy or slow, and the answer is bounded by one decision point per operation (`commitPoint` in `auth/src/nativeStore.ts`), called immediately before the write that cannot be undone: the consent's single `INSERT INTO native_grant`, and the exchange's `COMMIT`.

- **Guaranteed.** A `503` caused by the response deadline (2.5 s) means no grant or credential was committed and none will be: once the deadline has answered, the write is not sent. The exchange's code stays unspent (usable until its 60 s expiry) and adds no credential; a timed-out consent leaves no grant. The limiter row and the prune of expired grants may still commit; both are harmless, and the limiter's commit is deliberately not gated, so an abandoned attempt still counts against its IP.
- **Once the write is sent, the answer waits for its outcome** (no deadline `503` in between), bounded by the pool's own timeouts: about 8.5 s at most from the timer settings (2 s checkout, 2 s query timeout, 2 s `ROLLBACK` wait, plus event-loop lag), under the app's 15 s request timeout.
- **Not guaranteed.** (a) The gateway lost the connection, or hit the query timeout, while the `COMMIT` (or the consent `INSERT`) was in flight: `503`, and the write may or may not have happened. (b) The write committed and the `200` or `303` never reached the phone (client disconnect, app kill, gateway exit). In both cases the code may be spent and a credential or grant row may exist.
- **Why that is safe.** The token exists only in gateway memory and in the response; only its hash is stored, and it can only read the Collection, for 24 hours. A grant needs the device's verifier and lasts 60 s. Nobody holds a usable copy unless the response was delivered. The collector signs in again. Such a row is not revoked before its expiry.
- No compensation, retry or idempotent re-issue: a compensating delete cannot see an uncommitted row and would race the `COMMIT` it compensates, and re-issuing for a spent code would weaken single use. The app never retries an exchange.

Every native HTML page carries `cache-control: no-store`, `referrer-policy: same-origin`, `x-content-type-options: nosniff` and `content-security-policy: default-src 'none'; style-src 'unsafe-inline'; form-action 'self' prizecheck-native:; base-uri 'none'; frame-ancestors 'none'`. The `form-action` list names the app's callback scheme because CSP Level 3 applies `form-action` to the redirect that follows a form post: with `'self'` alone, WebKit or Chromium can block the `303` from `POST /auth/native/approve` to `prizecheck-native://auth/callback`. This replaces the `form-action 'self'` in the original brief. The only other change to these headers is the referrer policy, `same-origin` instead of `no-referrer` (see "Fixed: consent POST Origin and the referrer policy" below); no other directive or header changed.

Only sha256 hashes of the code and the token are stored. Nothing logs a code, verifier, token, header or body.

## Authorization is decided first

With the switch on, a request that carries any `Authorization` field and is in the API namespace is decided before everything else the gateway does: before the `/api/pokemon` 404 and alias rewrite, the Riftbound refusal, session lookup, rate limits, Origin checks and any upstream call. The namespace is read twice, on the raw request target (absolute-form authority removed, `\` read as `/`, percent-encoding undone) and on the pathname the gateway would dispatch, and either reading in `/api` counts. The request is allowed only when all of these hold; otherwise it is `401 {"error":"Authentication required"}` and never falls back to the cookie:

- the method is `GET` (`HEAD` and every other method are refused);
- the request target is exactly `/api/collection`, or `/api/collection?cursor=<value>` as above. Absolute-form targets, dot segments, encoded or backslash separators, a trailing slash, other query shapes and `/api/pokemon/...` or `/api/riftbound/...` aliases of anything are refused;
- there is no `Cookie` header;
- exactly one `Authorization` field is present (counted on the raw header list, so a duplicate in either order is refused) and it is `Bearer ` plus a 43-character token;
- the token's hash is a stored credential of scope `collection:read` that is neither expired nor revoked.

`Authorization` is never forwarded to the API. With the switch off, or with no `Authorization`, none of this runs and the gateway behaves as it does without the feature.

## Fixed: consent POST Origin and the referrer policy

With `referrer-policy: no-referrer` on the HTML pages, a real browser's consent form POST carried `Origin: null` and the gateway's exact-Origin check refused it with 403. The gateway's HTML pages now send `same-origin`, so the form POST carries the exact `PUBLIC_ORIGIN`. The `302`/`303` redirects still send `no-referrer`, JSON responses are unchanged (they set no referrer policy), and the Origin check is unchanged: a test pins that `Origin: null` is still refused. The simulator stub (`mobile/native-fixture.mjs`) already used `same-origin`.

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

- **Intercepting a code is not enough.** The code is useless without the PKCE verifier, which never leaves the app that started the flow, so an app that merely sees the callback URL cannot exchange the code.
- **The gateway can't tell which app started a sign-in.** Another app can start its own flow, with its own verifier, and send the collector to a `/auth/native/start` link of its own. It still needs the collector to sign in and tap **Allow**; if they do, the credential goes to that app. The app's callback scheme, `prizecheck-native://`, is not registered by the app, so nothing stops another app from claiming it either. The consent page therefore says "the app" and never names Prizecheck. Before production, switch to an HTTPS callback that only this app can receive: `ASWebAuthenticationSession.Callback.https` with Universal Links, which need the owner's Apple team ID and an `apple-app-site-association` file. Also decide on app attestation.
- **All native database work has its own small pool, admission and lock.** The bearer lookup, sign-out, the per-IP consent and exchange limits, the grant write and the code exchange run only on a separate pool (`auth/src/nativeStore.ts`): two connections, a two-second connect, statement, query and lock timeout, created only while the switch is on and tagged `application_name=prizecheck-native`. The web sign-in pool, its limiter and its advisory lock (`914704`) are not used; the native limits keep the same persisted per-IP numbers (20 consents and 30 exchanges an hour) in their own table, `native_rate_event`, under their own lock key, `914708`; they share no table, lock, prune or row with the web sign-in limits (`auth_rate_event`, `914704`), so locks on either side do not delay the other. A connection checked out for the limiter's transaction or the code exchange listens for connection errors until it goes back to the pool: a failed or lost connection is discarded, never reused, and the answer is the same `503` (or the committed answer, when the connection was lost only after the `COMMIT`). Each operation first takes an in-process slot, counted in flight plus waiting, and over the cap it is refused before any SQL is queued with `503` and `no-store`. A slot is kept until the database work settles, not until the response deadline (2.5 s), so abandoned work cannot pile up past the cap. The classes and numbers, for two connections: bearer lookups 4 held and 1 running (so reads can never hold the second connection), sign-out 2 and 2, code exchange 2 and 2 (the limiter transaction, then the single-use swap in a transaction of its own, one after the other), consent 2 and 2. A malformed, duplicated, cookie-bearing, wrong-method or off-path request is still a 401 with no database work. The consent form is read and shaped before the web session is looked up. On SIGTERM or SIGINT, with the switch on, the gateway stops taking connections, drains for up to five seconds, closes the native pool once and exits; a second signal does nothing. With the switch off, signals keep Node's default behaviour. Remaining contention: all native operations share the two connections, so a flood of well-formed bearers still delays sign-out, consent and exchange by up to a couple of seconds at a time, and the `503`s say so.
- **Sign-out is durable on the phone, with these limits.** The app removes the readable credential and records the pending revocation in one Keychain write, resolves without waiting for the network, and retries on every app activation (cold launch included), on sign-out and on the next sign-in (a trigger that arrives during a running pass queues one follow-up pass), until the gateway answers `204` or the credential's own expiry has passed. A pending credential is never used for a read, never reported as signed in, and never sent to another gateway origin. Residual cases, in each of which the server credential ends at its 24-hour expiry: the app is never opened again, or is deleted or reinstalled (the first-load purge drops pending entries); the Keychain refuses the update (one in-memory attempt only, and earlier pending entries are lost with the deleted item); the Keychain cannot be read at sign-out (the item is deleted with no attempt to revoke it or its pending entries); the Keychain refuses the delete as well (the credential can reappear as signed in on relaunch, unless the in-memory attempt revoked it, in which case the first read is a `401` and removes it); the app stays in the foreground after a failed attempt (next try at the next activation, sign-in or sign-out). The full table is in `NATIVE_SIGN_IN_IOS.md`. The Swift side has not been compiled or run: see `VERIFICATION.md`.
- **Header limit.** With the switch on the gateway sets `maxHeadersCount` to 0, so every header field the parser's 16 KiB limit lets through reaches the checks above (a duplicate `Authorization`, a `Cookie` or an `Origin` after many small fields). On Node 22.23.5 and 26.13.1 the default already refuses more than about a thousand fields with a 400 or 431 rather than dropping them; the setting keeps the checks independent of that runtime behaviour.
- **With the switch on, `Authorization` on `/api/*` means native.** Any request in the API namespace, `/api/pokemon/*` and `/api/riftbound/*` included, that carries an `Authorization` header, other than a valid native read of the Collection as described above, gets 401, including a web cookie request. A nonprod host behind HTTP Basic auth that passes the header through to the gateway breaks the web app while the switch is on, so strip the header at that proxy. The deploy nginx passes the header through unchanged (`tests/tooling/test_proxy_config.py` checks).

## Accepted for nonprod, required before production

The owner accepted both items for nonprod. Each is a decision required before production (ticket #688 tracks this slice).

1. **The consent page and the consent POST use the shared web session lookup before native admission** (`getSession` in `auth/src/native.ts`, on the web pool). A flood of native consent requests can therefore use web-pool connections. Ticketed separately as #691, required before production.
2. **Signing out on the web doesn't sign out the phone.** A native credential is separate from the web session. Web sign-out or revoking the web session leaves it valid for up to 24 hours. It ends only when the app signs out (`POST /auth/native/sign-out`), when it expires, or when the account is deleted, which cascades. Not yet ticketed on its own; it is covered by #688's decision list.
