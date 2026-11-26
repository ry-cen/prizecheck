# Native sign-in: the iOS side (nonprod, opt-in)

The app can sign a collector in through the gateway's native sign-in and read their Collection. It is **off by default**: the default build has no gateway, and shows the fixture demo exactly as before. The gateway side, and the HTTP contract this app follows, are in `mobile/NATIVE_SIGN_IN.md`.

## How it works

1. `NativeSignIn` (`mobile/ios/App/App/NativeSignInPlugin.swift`) is a local Capacitor plugin. `PrizecheckBridgeViewController` registers it in `capacitorDidLoad`.
2. **Sign in** creates a PKCE verifier (32 bytes from `SecRandomCopyBytes`), its S256 challenge and a state, then opens `G/auth/native/start?challenge=…&state=…` in an `ASWebAuthenticationSession` (ephemeral, callback scheme `prizecheck-native`). The collector signs in on the web, sees the consent page, and taps **Allow**.
3. The callback `prizecheck-native://auth/callback?code=…&state=…` is checked strictly: scheme, host `auth`, path `/callback`, `code`+`state` or `error`+`state`, each once, and the state this attempt created. Verifier and state are dropped on every outcome.
4. The app posts the code and verifier to `G/auth/native/token` with a native `URLSession` and keeps the `{token, expires_at}` answer in the **Keychain** (one generic-password item, service `app.prizecheck.native-credential`, account = gateway origin, `WhenUnlockedThisDeviceOnly`; the item holds a record with the readable credential and the list of credentials pending revocation, updated in place, never deleted before it is written). The token never reaches JavaScript.
5. `collection({cursor})` runs a native GET of `G/api/collection` with the bearer. A 401, or a credential past its expiry, clears the readable credential and reads as signed out. `signOut()` is durable (see "Durable sign-out" below): it removes the readable credential and records the pending revocation in one Keychain write, resolves at once, and the revocation is retried until the gateway confirms it.

The URL session is ephemeral, sets and stores no cookies, has no cache, refuses every redirect and times out after 15 s. Nothing here logs URLs, codes, tokens or response bodies. Every plugin method first checks that the web view is on the packaged origin (`capacitor://localhost`).

The JavaScript side is `web/src/shell/ios/nativeSignIn.ts`. `IosPrototype` calls `status()` on mount: configured means native mode (header "Prizecheck", **Sign in**, the Collection states, **Sign out**); anything else, including a web build where the plugin does not exist, means the fixture demo.

## Configuring a gateway

- `Info.plist` has `PrizecheckGatewayOrigin = $(PRIZECHECK_GATEWAY_ORIGIN)`. `mobile/ios/debug.xcconfig` sets the variable empty, so a stock build is not configured.
- A **non-Debug** build accepts only an `https://` origin with no path, query or userinfo.
- A **Debug** build also accepts the launch argument `-PrizecheckGatewayOrigin <origin>` (from the argument domain only), and only for `http://127.0.0.1:<port>` or `http://localhost:<port>`.
- Anything else means not configured.

The gateway's native pages allow `form-action 'self' prizecheck-native:` so the consent form's `303` to the app callback is not blocked (see `NATIVE_SIGN_IN.md`); the fixture sends the same header.

No URL scheme, App Transport Security, CSP (`connect-src 'none'` still holds: the web view makes no requests), signing or `capacitor.config.ts` setting changed.

## Simulator stub

`node mobile/native-fixture.mjs` listens on **127.0.0.1:4320 only** and mirrors the gateway contract with in-memory state: one sample collector who is always signed in (so no provider step), the consent page, approve, the PKCE token exchange, `GET /api/collection` with two sample pages (Bulbasaur and Charmander, then Squirtle), and sign-out (`400` for a request that names no single token, `503` while a test fault is on, otherwise `204`). It holds no credentials and logs nothing about requests. Loopback-only control routes for the simulator test, each answering `200` with counts only (`live`, `refused`, `confirmed`, `held`): `GET /fixture/state`, `POST /fixture/sign-out/fail` (sign-out answers `503` and revokes nothing), `POST /fixture/sign-out/ok`, `POST /fixture/sign-out/hold` (a well-formed sign-out is parked; its answer is decided on arrival but sent, counted and applied only on release; `held` counts the parked ones) and `POST /fixture/sign-out/release` (answers every parked sign-out and stops holding). The gateway has no such route. `mobile/native-fixture.test.mjs` runs the contract over HTTP, including a wrong verifier, single-use codes, expiry and the bearer's scope rules.

`mobile/validate-simulator.sh` starts and stops the stub next to the existing demo fixture and checks that the listener is on loopback. `AuthNativeSignInUITests.testNativeSignInRestoreAndDurableSignOut` launches with `-PrizecheckGatewayOrigin http://127.0.0.1:4320` and (1) signs in (the system "Continue" alert if iOS shows one, then **Allow**), relaunches and sees the first card restored; (2) turns the stub's sign-out fault on and signs out: signed out at once, the credential still live on the stub, and a refusal counted; (3) signs in again, which retries the pending token; (4) signs out again, still refused; (5) terminates and relaunches: signed out (a pending token is never a sign-in), and the launch retries both tokens; (6) turns the stub's hold on and activates the app, so a pass parks on its first token (nothing counted yet); activates it again while the pass is parked, turns the fault off and releases: the running pass ends with the first token refused and the second revoked, and the queued follow-up pass revokes the first, so both are confirmed and none is live; (7) relaunches and is still signed out. The five demo tests are unchanged and launch without the argument.

## Durable sign-out

Sign-out removes the readable credential and records its pending revocation in ONE Keychain update (`NativeCredentialStore.retire`), so after a crash the credential is in exactly one of the two. It resolves without waiting for the network. The revocation (`POST G/auth/native/sign-out`) is then sent, and **retried** at every app activation (the plugin observes `UIApplication.didBecomeActiveNotification` and checks once at load for a cold launch), on sign-out and on the next sign-in, one pass at a time, one request per pending token. A trigger that arrives while a pass runs queues exactly one follow-up pass, which starts when the running pass ends; a failed attempt queues nothing, so a gateway that keeps failing costs one pass per trigger. A pending token is removed only on a `204`, or after an attempt at or past its expiry. Only `204` confirms: the gateway never answers `401` here, so a `401`, `404` or `3xx` comes from an intermediary or a switched-off gateway and the token stays pending until its expiry. A pending token is never used for a read, never reported as signed in, and never sent to another gateway origin. An exchange that finishes after a sign-out never installs its credential; it is queued for revocation. There is no timer and no background task.

| Event                                      | Result                                                                                                |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Killed before the Keychain write           | sign-out did not take; still signed in on relaunch                                                    |
| Killed after the write, before the request | pending; the next activation sends it                                                                 |
| Server revoked, 204 lost                   | resent, 204 again, removed                                                                            |
| Killed after the 204, before removal       | resent, 204, removed                                                                                  |
| An exchange finishes after sign-out        | its credential is never installed; it is queued for revocation                                        |
| Sign-out of A fails, B signs in            | reads use only B; A's token is sent only to sign-out                                                  |
| Several sign-outs fail                     | each is one entry; one 503 does not stop the others in the pass                                       |
| App configured for another origin          | that origin's item is never read; retried when the app uses it again, otherwise the server expires it |
| Switch turned off                          | 404; stays pending, removed after an attempt past expiry                                              |
| Device clock ahead                         | still attempted at least once before removal                                                          |

Residual cases (the server credential then ends at its 24-hour expiry): the app is never opened again, or is deleted or reinstalled (the first-load purge drops pending entries); the Keychain refuses the update (one in-memory attempt only, and earlier pending entries are lost with the deleted item); the Keychain cannot be read at sign-out (the item is deleted with no attempt to revoke it or its pending entries); the Keychain refuses the delete as well (the credential can reappear as signed in on relaunch, unless the in-memory attempt revoked it, in which case the first read is a `401` and removes it); the app stays in the foreground after a failed attempt (the next try is at the next activation, sign-in or sign-out). `signOut()` rejects with `KEYCHAIN` only when the Keychain refused both the update and the delete; the web layer ignores that rejection and shows signed out. An item written by an earlier build of this branch is undecodable and reads as empty; no build shipped.

## Local checks (Linux)

```sh
npm run local:exclusive -- npm run test:ios
npm run local:exclusive -- npm run check
npm run local:exclusive -- npm run build:ios
node --test mobile/native-fixture.test.mjs
```

**Swift is not compiled on Linux.** It was written against the Capacitor 8.6.2 iOS sources in `node_modules/@capacitor/ios`; the hosted macOS job compiles and runs it.

A Keychain item survives deleting the app, so on the first plugin load after an install `NativeCredentialStore.purgeLeftoverCredentialsOnFirstLoad` deletes every native credential under the store's service (any gateway origin). It detects that first load with the `nativeSignIn.installMarker` `UserDefaults` flag, which an uninstall wipes. It logs nothing and leaves the Keychain attributes alone.

## Real gateway walkthrough (a nonprod gateway you run yourself)

Start the gateway as described in `mobile/NATIVE_SIGN_IN.md`, give the build its `https://` origin as `PRIZECHECK_GATEWAY_ORIGIN`, and run on the simulator. **Do not write `https://host` in an `.xcconfig` file:** there `//` starts a comment, so the value becomes `https:` and the app quietly runs unconfigured, on the fixture demo. Use one of the safe forms instead:

- in a local, untracked xcconfig, break the slashes up with an empty macro: `PRIZECHECK_GATEWAY_ORIGIN = https:/$()/host.example`;
- or pass it on the command line, which does not go through xcconfig parsing: `xcodebuild ... PRIZECHECK_GATEWAY_ORIGIN=https://host.example`.

A physical device cannot reach a gateway on the host's loopback; do not widen the listener or relax ATS to work around this.

## Not covered

Physical-iPhone behaviour, real accounts, production, token refresh and native credential rotation. A credential lasts 24 hours; after that the collector signs in again.
