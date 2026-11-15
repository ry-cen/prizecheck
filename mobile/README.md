# iOS shell and sign-in prototype

This first slice packages a separate React/Vite entry in Capacitor. It reuses the web product's tokens, buttons, card tiles and generated `CollectionPage` contract. It deliberately shows only a read-only sample Collection. The full Workspace, scanner and other product areas are not bundled into this entry.

**This is not real account authentication.** Browser completion creates a synthetic, fixed collector session with a 30-minute lifetime. It grants no gateway or API access. There is no API transport, account input, provider token, secret, cookie transfer, native HTTP plugin, CORS change or production configuration. The entry's CSP forbids network connections. The web application's bootstrap and auth gateway are unchanged.

## Linux setup and checks

Use the repository's `docs/agents/local-testing.md` instructions to install this worktree's dependencies and use admission for heavy commands:

```sh
npm run local:exclusive -- npm run build:ios
npm run local:exclusive -- npx vitest run web/src/shell/ios/fixtureSession.test.ts
npm run local:exclusive -- npm run ios:sync
```

The native project lives in `mobile/ios`. `npm run ios:sync` rebuilds packaged assets and syncs plugins. Generated web assets and Capacitor JSON are ignored; commit the native scaffold and Swift package manifest. No signing team or credentials are configured.

## Local fixture walkthrough (simulator host)

Run `npm run ios:fixture` on the simulator's host. It binds **127.0.0.1:4319 only**. The app launches this page using the operating system's browser (`AppLauncher`), not embedded provider sign-in. The page offers success, cancellation and error outcomes, with no credential fields. A return link uses `prizecheck-prototype://auth/return`. `App.appUrlOpen` handles a running app; `App.getLaunchUrl` handles a cold start.

Only the exact return route and a random 256-bit pending state are accepted, for five minutes. Matching attempts are consumed once. Replays, wrong state, wrong routes, duplicate fields and extra credential parameters cannot sign in. State is persisted so process termination during the browser trip can recover. Demo session persistence is intentionally localStorage; **never substitute a real session token into this store**. Real native access needs a reviewed secure-storage and server-side revocation design.

Walk through success → sample Collection → terminate/relaunch → Collection recovery → Sign out → relaunch signed out. Also cancel in the app, cancel in the browser, simulate an error, and leave an attempt open five minutes. A session expires after 30 minutes; foreground polling and resume checks unmount the sample Collection. Closing the browser without returning leaves the app's Cancel sign-in action available. A failed browser launch shows a retry message. A real device cannot reach a Linux fixture server via its own loopback address; do not widen the listener or relax ATS to work around this.

## Production handoff decision required

The existing Better Auth gateway uses same-origin HttpOnly cookie sessions and forwards signed internal requests to the private FastAPI API. Safari's cookie jar is not WKWebView's cookie jar, and a packaged app's origin is not the web origin. A wrapper alone cannot reuse browser login safely.

Before live-account work, review an explicit gateway-mediated native handoff: exact callback allowlist, PKCE-bound single-use short-lived exchange, authenticated browser approval, secure device credential storage, expiry/revocation, user isolation and gateway-only Collection access. Define CSRF/Origin behavior without trusting a caller-supplied user or bypassing the existing web rules. This prototype implements none of those production permissions or endpoints. The return `state` and `result` fields here are demonstration controls, not an OAuth protocol.

## Unsigned simulator validation

The branch now has a narrowly scoped [simulator workflow](../.github/workflows/ios-prototype.yml), restricted to public same-repository PR #671, this exact feature branch and relevant paths. It uses the standard `macos-15-intel` public runner and installed Xcode 26.3, `contents: read`, a 25-minute timeout and no artifact/cache upload. No runner/account permissions or default-branch workflows were changed. The existing credentials already had workflow rights. GitHub documents [standard public runners as free](https://docs.github.com/en/actions/reference/runners/github-hosted-runners); larger runners and storage have different billing and are not used here.

The job checks out and logs the exact PR head, syncs packaged assets, and runs `xcodebuild build-for-testing` with `CODE_SIGNING_ALLOWED=NO`. It then creates one simulator, explicitly installs and launches the compiled app, starts the fixture on **127.0.0.1:4319 only** on that same host, and runs the `FixtureValidation` XCTest scheme. It changes no ATS, CSP, cookie, Origin, CSRF, signing-team or host security settings. Cleanup stops the owned server and deletes the owned simulator.

Four XCTest scenarios attempt the real WKWebView/AppLauncher/Safari/scene-bridge paths: warm return plus relaunch recovery/sign-out, cold return after app termination, browser cancellation/error, and cancellation after native app resume. They use real UI elements with no injected JavaScript or mocked plugins. A 30-minute native expiry walkthrough is deliberately outside the job's time cap; expiry and the appStateChange expiry callback have unit evidence only. The added getLaunchUrl unit test also remains mocked evidence, separate from cold native return.

**A workflow or test definition is not a successful native run.** Consult the exact-head run and PR evidence for compile and per-scenario outcomes. No result here establishes physical-iPhone behavior or real-account sign-in. Capacitor 8 requires [Xcode 26 or later](https://capacitorjs.com/docs/getting-started/environment-setup); if the pinned hosted toolchain/runtime is unavailable, report that blocker without installing credentials or broadening permissions.

## Verification record

See [VERIFICATION.md](VERIFICATION.md) for commands, counts, repaired setup failures and the remaining failed optional aggregate run.
