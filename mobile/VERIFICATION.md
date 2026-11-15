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

- Native Xcode compilation, simulator interaction and physical iPhone sign-in: not run. Linux generation/sync and jsdom tests are not device evidence.
- Real-account authentication or a real Collection in the native shell: not implemented or tested. Only sample data is shown. A production gateway-mediated handoff and secure credential-storage design remain a separate decision.
- API tests, operations suite, full application gate and scanner real-model execution: not run for this slice. No API tests were changed.
- GitHub CI and independent review are separate acceptance evidence; local results do not approve this implementation.

See [README](README.md) for the proposed unsigned hosted macOS simulator build and its exact next action. No macOS workflow or runner/account permissions were added.

## Simulator validation continuation

The continuation rechecked the same clean Linux worktree and PR head `2c326ed4d6d6df9a4cd3fc72a673b3c2cb912be1`; no competing iOS T3 owner was active. Repository metadata confirmed PUBLIC visibility, existing ADMIN access, Actions enabled, allowed actions and existing `workflow` OAuth scope. GitHub's standard-runner reference lists `macos-15-intel` as free for public repositories; its installed-image manifest includes Xcode 26.3, above Capacitor 8's minimum Xcode 26.0. No permissions, billing or account settings were changed.

A PR #671/branch-only simulator workflow, shared XCTest scheme/target, four real UI scenarios and a loopback-only runner script were added. The script explicitly installs and launches the built app; the hosted job separates compile from UI execution, logs the exact head and toolchain, and uploads no artifacts or caches. Runtime outcomes belong to the exact-head Actions logs and PR evidence, not to these definitions.

Local continuation checks: 13 protocol/UI tests plus one loopback HTTP contract test passed, as did TypeScript/generated-contract checks, shell syntax and scheme XML parsing. The two new jsdom tests cover a populated getLaunchUrl on startup and appStateChange expiry without advancing the polling timer. These are mocked callback tests, not native evidence.

Historical CI qualification: the original head's Linux Verify and title checks were green, but its shallow checkout skipped the three historical migration tests. The prior local full tooling runs exercised those tests; do not describe every tooling test as exercised in the shallow CI checkout. The earlier optional auth aggregate failure remains recorded above and is not superseded by native validation.

Native 30-minute expiry, physical-device behavior, real accounts and a real private Collection remain unexercised. No API, scanner, signing, deployment or production-auth change is part of this continuation.
