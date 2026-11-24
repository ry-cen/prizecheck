# iOS prototype verification

Environment: Linux T3 `ryan-dev-vm`, `0bd1d3b3-6f07-4f25-895c-8f64d49bfc30`.

Worktree: `/home/ryan/.t3/worktrees/prizecheck/feature-ios-shell-signi-8ab93ebc079d0f4f`, branch `feature/ios-shell-signin-prototype`, origin `https://github.com/ry-cen/prizecheck.git`. Before edits, the working tree was clean and HEAD and freshly fetched origin/dev both equaled `1bac580100876c5c16e08e21045759a26f5dcaec`. A final fetch still resolved dev to that SHA. The PR records the resulting implementation commit.

All installs/builds/checks used the existing Linux admission commands and worktree-local dependencies. PostgreSQL-backed runs used `verify:local`, disposable databases, synthetic data and the existing OAuth fake. No owner's MacBook, live accounts, production services, credentials or signing configuration were used.

## Passed

- `npm run test:ios`: 11 protocol/UI tests and one loopback HTTP fixture contract test.
- `NODE_OPTIONS=--no-experimental-webstorage npm run test:unit`: 2,969 passed (163 files), plus one loopback HTTP contract test. The flag disables Node 26's unavailable browser-storage global so jsdom can supply its own. CI selects Node 22.
- `npm run check`: auth/web/mobile TypeScript, scanner model lock and generated clients.
- `npm run guardrails`: scripts/boundaries plus 678 tooling tests. Also passed inside the final isolated auth run.
- Targeted `test_case_collisions.py`: 13 passed.
- `npm run build`, `npm run check:bundle`, `npm run build:ios`, `cap add ios`, `npm run ios:sync` and `npx prettier --check .`.
- Browser run `20261115T020450Z-a80b3ec3`: **25 passed, zero failed/flaky/skipped**. Command:

  ```sh
  npm run verify:local -- --suite browser --shard 1/1 --browser-workers 1 -- \
    web/tests/oauth-sign-in.spec.ts web/tests/sign-in-failures.spec.ts \
    web/tests/sign-in-destination.spec.ts web/tests/workspace-gallery.spec.ts
  ```

  `result.json` reports `database_removed: true`, no cleanup failures, no suspension/network warnings.

## Failed aggregate run — remains reported

```sh
NODE_OPTIONS=--no-experimental-webstorage npm run verify:local -- --suite auth --fast
```

Run `20261115T021846Z-cc929de9`: **3,143 passed, 17 failed, 33 skipped**. All failures are the unchanged `web/src/loans/loanCreationAuthority.test.ts` setup using Node 26's unavailable `window.localStorage`. The isolated runner intentionally inherits only selected variables and drops `NODE_OPTIONS`; the flag that fixes the direct unit run therefore does not reach this run. No isolation setting was broadened to work around it.

The JUnit report's `auth/tests/` subset is **191 passed, zero failed, 28 skipped** (slow checks excluded by `--fast`). The run's guardrails, type checks, web build and bundle boundary passed. Database cleanup completed with no failures. This is a failed aggregate run, not a green gate.

## Repaired setup failures and small deviations

The standard `python3 -m venv` failed because this host lacks ensurepip. The already-installed `uv` created this worktree's environment without system changes.

Initial protocol tests passed, but UI tests hit Node 26/jsdom's storage-global conflict. The new prototype tests now explicitly supply jsdom storage. The ordinary full web unit run initially had 2,952 passes and 17 failures in the existing Loan test; its flagged rerun passed all 2,969.

The first guardrails run had six case-collision subtest failures: an empty child `.git` fixture discovered the enclosing worktree. The helper now checks the exact Git top-level rather than merely being inside any worktree. All 13 relevant tests and all 678 tooling tests then passed.

The first copied auth gate stopped on three historical migration extraction errors. Those helpers now use the runner's existing `RELEASE_TEST_HISTORY_ROOT`, rather than applying archive paths relative to the copied checkout. The final copied gate passed these tests. These two test-helper changes are deviations from the product slice; neither changes admission, auth or application behavior.

The initial Capacitor add attempt from `mobile/` failed because it is not an npm package root. The config now lives at the repository root with `ios.path: mobile/ios`. Add/sync succeeded. Formatting exclusions cover only Capacitor-owned config and copied/minified assets; native asset manifests are formatted normally.

## Unproven / never run

- Physical iPhone sign-in: not run. Linux generation/sync, jsdom tests and simulator runs are not device evidence. Unsigned native compilation and simulator UI later ran on hosted macOS; see [the hosted results](#passing-hosted-native-result--32765b76) below.
- Native 30-minute session expiry: not exercised on the simulator or a device. Expiry has jsdom/unit evidence only.
- Real-account authentication or a real Collection in the native shell: not implemented or tested. Only sample data is shown. A production gateway-mediated handoff and secure credential-storage design remain a separate decision.
- API tests, operations suite, full application gate and scanner real-model execution: not run for this slice. No API tests were changed.
- GitHub CI and independent review are separate acceptance evidence; local results do not approve this implementation.

This list was first written before any macOS work. The continuation below added the simulator workflow for PRs #671 and #676 only; no runner or account permissions were changed.

## Simulator validation continuation

The continuation rechecked the same clean Linux worktree and PR head `2c326ed4d6d6df9a4cd3fc72a673b3c2cb912be1`; no competing iOS T3 owner was active. Repository metadata confirmed PUBLIC visibility, existing ADMIN access, Actions enabled, allowed actions and existing `workflow` OAuth scope. GitHub's standard-runner reference lists `macos-15-intel` as free for public repositories; its installed-image manifest includes Xcode 26.3, above Capacitor 8's minimum Xcode 26.0. No permissions, billing or account settings were changed.

A simulator workflow for PRs #671 and #676 only, shared XCTest scheme/target, four real UI scenarios and a loopback-only runner script were added. The script explicitly installs and launches the built app; the hosted job separates compile from UI execution, logs the exact head and toolchain, and uploads no artifacts or caches. Runtime outcomes belong to the exact-head Actions logs and PR evidence, not to these definitions.

Local continuation checks: 13 protocol/UI tests plus one loopback HTTP contract test passed, as did TypeScript/generated-contract checks, shell syntax and scheme XML parsing. The two new jsdom tests cover a populated getLaunchUrl on startup and appStateChange expiry without advancing the polling timer. These are mocked callback tests, not native evidence.

Historical CI qualification: the original head's Linux Verify and title checks were green, but its shallow checkout skipped the three historical migration tests. The prior local full tooling runs exercised those tests; do not describe every tooling test as exercised in the shallow CI checkout. The earlier optional auth aggregate failure remains recorded above and is not superseded by native validation.

Native 30-minute expiry, physical-device behavior, real accounts and a real private Collection remain unexercised. No API, scanner, signing, deployment or production-auth change is part of this continuation.

### First hosted native result — 41b2a206

[Run 43670914443](https://github.com/ry-cen/prizecheck/actions/runs/43670914443/job/132680519949) used the standard hosted macOS/Xcode 26.3 environment and logged `CODE_SIGNING_ALLOWED = NO`. Swift Package Manager resolved the native dependencies, the app and XCTest bundle compiled/linked, and xcodebuild printed **TEST BUILD SUCCEEDED**. This establishes an actual unsigned simulator-target native build at head `41b2a206bb925415bcf44ed140333c5ff597ffd5`, not a successful workflow or UI run.

The workflow step failed because `tee` opened `.scratch/ios-build.log` before the directory existed; `pipefail` correctly reported that logging failure. Simulator install/launch and all four UI scenarios were skipped, so none has native UI evidence from this run. The repair explicitly creates `.scratch` before the pipeline; it does not suppress failures, change permissions or alter the packaged app.

### Passing hosted native result — 32765b76

[Run 43671627449](https://github.com/ry-cen/prizecheck/actions/runs/43671627449/job/132682728586) at head `32765b762a627c017b5bab6d361b2ff8a00874f9` used macOS 15.7.9 with Xcode 26.3. The unsigned build (`CODE_SIGNING_ALLOWED=NO`) printed **TEST BUILD SUCCEEDED**. `simctl` then installed and launched the app on an iPhone 17 simulator running iOS 26.2, and XCTest reported **4 passed, 0 failed, 0 skipped**:

- warm Safari return, then relaunch recovery, sign-out and a signed-out relaunch
- cold return after the app was terminated
- browser cancellation and error
- app cancellation after a native resume

The fixture listener was confirmed at 127.0.0.1:4319 on the same host. Linux Verify for the same PR head (its merge ref with dev `1bac5801`) passed 2,971 web unit tests and the HTTP contract test. Its shallow checkout skipped three historical migration tooling tests, which do run locally.

This is simulator evidence with sample data only. It does not cover native 30-minute expiry, a physical iPhone, real accounts or a real Collection.

### Failed rerun and repair — 42e0a006, 95a644f4

[Run 43698492747](https://github.com/ry-cen/prizecheck/actions/runs/43698492747/job/132764179488) at `42e0a006` failed **4 of 4** scenarios. That commit changed only documentation, so the app and tests were the same ones that passed at `32765b76`. The runner was slow: creating and booting the simulator took 4m53s, against 3m50s for the passing run. In the first test Safari came to the foreground, but the fixture link did not appear within 20 seconds. That left a pending sign-in attempt saved. On relaunch the app correctly showed only **Cancel sign-in**, which the old `setUp` did not handle, so the other three tests failed in `setUp`. The logs do not show what Safari displayed, and they do not point to Safari's first-run UI or the fixture listener. The listener was confirmed on loopback.

Commit `95a644f4` changes only `FixtureUITests.swift`:

- `setUp` also accepts and cancels a leftover attempt.
- `setUp` closes Safari before launching the app.
- The readiness wait and the first-page link wait go from 20 to 45 seconds.

No scenario step or assertion changed. [Run 43700919303](https://github.com/ry-cen/prizecheck/actions/runs/43700919303) at `95a644f4` passed **4 of 4, with 0 failed and 0 skipped** on the iPhone 17 simulator (iOS 26.2), after `TEST BUILD SUCCEEDED` with `CODE_SIGNING_ALLOWED=NO`. Linux Verify for the same PR head passed 2,971 unit tests and 678 tooling tests (three historical migration tests skipped in the shallow checkout).

One passing run after a repair does not prove the slow-runner flake is gone. A failing hosted run that recurs should be reported, not retried until it passes.

### Collection source and states (slice 2)

The prototype now reads sample pages through a typed `CollectionSource` and implements loading, empty, error with retry, refresh, show more and session-ended states, unit-tested with injected sources. The packaged sample app exercises only paging (Show more), Refresh and the session-ended message: its source never returns an empty page or `unavailable`, and loading lasts one microtask. The new native test covers Show more and Refresh. A gateway source exists but is not wired into the packaged app; no network, cookie, CORS, CSRF or Origin behavior changed.

A new `testCollectionShowMoreAndRefresh` UI scenario was added, and the existing four are kept.

[Run 43859035800](https://github.com/ry-cen/prizecheck/actions/runs/43859035800) at `68aa863b` passed **5 of 5, with 0 failed and 0 skipped**, on the iPhone 17 simulator (iOS 26.2). The job took about 16 minutes against its 25-minute timeout. Linux Verify for that PR head passed 2,988 unit tests and 678 tooling tests, with three historical migration tests skipped in the shallow checkout.

The next commit waits for Collection tiles instead of checking them at once. The pull request records the hosted result for that head. Native 30-minute expiry, so the session-ended message reached by expiry, is still unit-tested only.

### Hosted run 44036494533 — bd0a89ca

[Run 44036494533](https://github.com/ry-cen/prizecheck/actions/runs/44036494533) at `bd0a89ca` reported `TEST BUILD SUCCEEDED`. The five demo tests passed: `testAppCancellationAfterNativeResume` 78 s, `testBrowserCancellationAndError` 55 s, `testColdBrowserReturn` 39 s, `testCollectionShowMoreAndRefresh` 38 s and `testWarmBrowserReturnRecoveryAndSignOut` 69 s. The native sign-in test was cancelled by the 25-minute job timeout after 19 s, so it has no result.

XCTest runs classes in alphabetical order, so the native class ran last. It is renamed `AuthNativeSignInUITests` to run first; the timeout and runner are unchanged.

### Native sign-in stage diagnostics (candidate, not run)

A local-only candidate adds diagnostics to find where the native sign-in test stops after **Allow**. It changes no behaviour. A Debug build logs one line per stage to the `app.prizecheck.prototype` subsystem, category `native-stage`, with fixed labels and integer codes only. The native stub prints one allowlisted `route`, `method` and `status` line per response. The native test prints `native-ui-state=` and `native-auth-sheet=` when the first card does not appear, and `validate-simulator.sh` prints the stub and stage logs before it cleans up. None of this has run on a simulator or on a hosted runner.

### Hosted run 44153531511 — 72c96337 (native sign-in did not reach the app)

[Run 44153531511](https://github.com/ry-cen/prizecheck/actions/runs/44153531511) at `72c96337`: 5 of 6 tests passed; the native sign-in test failed. The stub logged `native-fixture route=approve_post method=POST status=403` and nothing after it. The app logged only `signin_begin`; the UI state was `sign_in_button` with the auth sheet in the foreground.

Local reproduction with headless Chromium against the committed stub: with the consent page's `referrer-policy: no-referrer`, the form POST arrives with `Origin: null` and fails the stub's exact-Origin check with 403. With only the referrer policy changed to `same-origin`, the POST carries the exact Origin and gets 303.

Fixture-only fix: the simulator stub's native pages now send `referrer-policy: same-origin`; the exact-Origin and nonce checks are unchanged, and a test pins that `Origin: null` is still refused. When this fixture-only fix was made (`af88637c`), the gateway was not changed. The gateway's own fix is the later "Fixed" note in `NATIVE_SIGN_IN.md`. [Run 44254633525](https://github.com/ry-cen/prizecheck/actions/runs/44254633525) at `af88637c` then exercised the fixed stub: 5 of 6 tests passed. The native test got past consent (`approve_post` 303, `token` 200, `callback_code`, `token_http status=200`) and failed at `keychain_save status=-34018`.

### Simulator ad-hoc signing (candidate, not run)

Hosted run 44254633525 at `af88637c` logged `keychain_save status=-34018` and the UI showed "Unable to sign in": the unsigned build (`CODE_SIGNING_ALLOWED=NO`) cannot use the Keychain. The workflow build and `validate-simulator.sh` test invocation now pass `CODE_SIGN_IDENTITY=-` (ad-hoc, no team, certificate, account or secret) instead, and the script prints the app's signature and entitlements after `simctl install`. No hosted or simulator run of this change has happened yet, so this records no pass.

### Durable sign-out (candidate, not run)

A local-only candidate makes native sign-out durable on the phone (`NativeCredentialStore.swift`, `NativeSignInPlugin.swift`) and extends the simulator test to `AuthNativeSignInUITests.testNativeSignInRestoreAndDurableSignOut`, driven by the stub's `/fixture/*` control routes. **The Swift is not compiled** (it cannot be on Linux), **and the simulator test has not run: Swift is NOT compiled and NOT verified until a hosted "iOS prototype simulator" run is recorded here.** Linux checks cover the gateway contract and the stub (`auth/tests/native-sign-in.test.ts`, `native-store.test.ts`, `mobile/native-fixture.test.mjs`) and say nothing about the Swift.
