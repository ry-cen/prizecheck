# Native sign-in: the iOS side (nonprod, opt-in)

The app can sign a collector in through the gateway's native sign-in and read their Collection. It is **off by default**: the default build has no gateway, and shows the fixture demo exactly as before. The gateway side, and the HTTP contract this app follows, are in `mobile/NATIVE_SIGN_IN.md`.

## How it works

1. `NativeSignIn` (`mobile/ios/App/App/NativeSignInPlugin.swift`) is a local Capacitor plugin. `PrizecheckBridgeViewController` registers it in `capacitorDidLoad`.
2. **Sign in** creates a PKCE verifier (32 bytes from `SecRandomCopyBytes`), its S256 challenge and a state, then opens `G/auth/native/start?challenge=…&state=…` in an `ASWebAuthenticationSession` (ephemeral, callback scheme `prizecheck-native`). The collector signs in on the web, sees the consent page, and taps **Allow**.
3. The callback `prizecheck-native://auth/callback?code=…&state=…` is checked strictly: scheme, host `auth`, path `/callback`, `code`+`state` or `error`+`state`, each once, and the state this attempt created. Verifier and state are dropped on every outcome.
4. The app posts the code and verifier to `G/auth/native/token` with a native `URLSession` and keeps the `{token, expires_at}` answer in the **Keychain** (generic password, service `app.prizecheck.native-credential`, account = gateway origin, `WhenUnlockedThisDeviceOnly`). The token never reaches JavaScript.
5. `collection({cursor})` runs a native GET of `G/api/collection` with the bearer. A 401, or a credential past its expiry, deletes the credential and reads as signed out. `signOut()` deletes the credential first, then asks the gateway to revoke it (best effort).

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

`node mobile/native-fixture.mjs` listens on **127.0.0.1:4320 only** and mirrors the gateway contract with in-memory state: one sample collector who is always signed in (so no provider step), the consent page, approve, the PKCE token exchange, `GET /api/collection` with two sample pages (Bulbasaur and Charmander, then Squirtle), and sign-out. It holds no credentials and logs nothing about requests. `mobile/native-fixture.test.mjs` runs the contract over HTTP, including a wrong verifier, single-use codes, expiry and the bearer's scope rules.

`mobile/validate-simulator.sh` starts and stops the stub next to the existing demo fixture and checks that the listener is on loopback. `NativeSignInUITests.testNativeSignInRestoreAndSignOut` launches with `-PrizecheckGatewayOrigin http://127.0.0.1:4320`, signs in (the system "Continue" alert if iOS shows one, then **Allow**), sees the first card, terminates and relaunches to see it again, then signs out. The five demo tests are unchanged and launch without the argument.

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
