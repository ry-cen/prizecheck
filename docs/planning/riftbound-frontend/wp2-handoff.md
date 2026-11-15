# #662 WP2 implementation handoff

Worktree: `/home/ryan/.t3/worktrees/prizecheck/t3-e928a38e-f8e5f7961cfc4a4b`.
Branch: `t3/riftbound-collection-writes`.
Review base: `a07c7a224ef77c10740ece45e823ad45347ef228` (reviewed WP1).
The final local commit SHA is reported with the handoff; independent exact-head review and acceptance belong to the primary.

## Setup and boundaries

`git fetch origin` passed. Initial HEAD was `6586c99bb9886a2b35d48a9ef721a0a588fe8692`; origin/dev was `1bac580100876c5c16e08e21045759a26f5dcaec`. The requested ff-only merge passed, and the clean checkout contained exactly d3fbd80d, 37451159, e2da5403, b98ca78a, 6586c99b, da407942, a07c7a22 above origin/dev. Only this branch/worktree was changed. No push, PR, merge into integration branches, hosted suite, deployment or other-worktree operation was performed. No delegate/advisor was used.

Dependencies were installed in this worktree through local admission. `python3 -m venv .venv` failed because ensurepip is unavailable; the authorized `uv venv --seed --clear .venv` fallback succeeded. The admitted npm ci, pip requirements installation and Playwright Chromium installation succeeded. Local hooks were installed without changing Git config. Doctor then passed all readiness lines (Node 26.13.1, own dependencies, hooks, Chromium 1243, native PostgreSQL 16). Admission requests were allowed to finish normally; no foreign reservation was audited/recovered/cancelled.

## Planner decisions and acceptance

| Decision | Implementation and evidence | Status |
| --- | --- | --- |
| 1. Contract | collection.ts owns CollectionWriter, confirmed ownerRevision results, explicit AbortSignal/key options, supported typed errors and no promise errors. Single Add has no Undo. Contract/HTTP distinction and #534 gate are documented. | Met for fixture scope |
| 2. Store | Owner/scenario memory stores share reader/writer state. Increment/delete-at-zero, revision versions, stale checks, canonical-payload replay, key reuse, newest five/expiry and injected clock are tested. Corrected Undo mirrors core leaf/overflow/destination-quantity checks; changed version alone does not refuse. Missing destination arrivals are tested after dismissing a newer removal; non-leaf source/destination and overflow use direct fixture edits. | Met |
| 3. Add | Composed-only CardPopup control, leaf picker/Unsorted, 1–99 Stepper, busy guard, frozen retry payload/key, confirmed no-Undo toast and revision refresh. Component test dispatches double submit and inspects the store; browser dispatches double native click and asserts exactly one increment and fourth exact copy. Success closes detail and returns focus to the Catalog tile. | Met |
| 4. Move/Remove | Local single-copy bar and Menu/Button, phone detail actions, path picker excluding source, explicit confirmation. Confirmed success refreshes/clears selection and focuses heading. Stale keeps one action dialog with Reload and retry; details never stack above it. Navigation/unmount/owner change invalidates late callbacks, including noncooperative writers. | Met |
| 5. Undo | Undo/Dismiss Undo toast; newest-only and core ordering; confirmed “Undone”; requested plain failure messages. Dismiss does not bump inventory revision, matching core. Older record access is intentionally absent from the one-toast UI; browser exercises the older record through the fixture module, while unit tests cover full ordering/expiry/compatibility. | Met |
| 6. Opus nits | Clamp compares page with max(1,pages); automatic clamp suppresses heading focus. Variant label is muted with separate value; empty inspector has dashed card outline. | Met |
| 7. Docs | collection-slice.md records verified/simulated semantics with re-read file:line citations and omissions. parity-map.md adds all four write surfaces and defect-1 avoidance. #663 prerequisites are planning only. | Met |
| 8. Tests/screenshots | Store/component unit tests and responsive browser cases cover commands, idempotency, lifecycle, retries, keyboard-only Move/Undo, phone focus, owner collisions, unchanged Pokémon preference sentinel and zero /api or /auth calls. Existing WP1/Catalog specs pass. Screenshots saved below. | Met |

## Actual verification

The DB-free commands were run inside `python3 scripts/local_admission.py exec -- bash -c '…'`. TMPDIR=/tmp was set **inside** the admitted shell for guardrails, as required by the known tooling fixture/Git discovery issue. No tests were disabled.

| Command | Actual result on final production source |
| --- | --- |
| `npm run check` | Passed TypeScript, scanner lock and generated clients. Also repeated by build. |
| `NODE_OPTIONS=--no-experimental-webstorage npm run test:unit` | 164 files, 2,988 tests passed, 0 failed. |
| `TMPDIR=/tmp npm run guardrails` | Passed mechanical/boundary checks and all 679 tooling tests. |
| `npm run build` | Passed. |
| `npm run check:bundle` | Passed: 15 lazy pages, both production entries and scanner boundary; no Riftbound production leak. |
| `npx prettier --check .` | Passed, all matched files formatted. |
| `TMPDIR=/tmp npm run verify:local -- --suite browser --shard 1/1 --browser-workers 1 -- web/tests/riftbound-collection.spec.ts web/tests/riftbound-catalog.spec.ts web/tests/riftbound-collection-writes.spec.ts` | Final run `20261115T130720Z-d5b2fb1a`: 21 passed, 0 failed, 0 flaky, 0 skipped. No clock/network warnings; database removed, cleanup_failures empty; local PG stopped. |

Logs are `.scratch/wp2-release-checks.log` and `.scratch/verification/20261115T130720Z-d5b2fb1a/verification.log` plus `result.json`. Baseline before edits: check passed; 163 unit files/2,971 tests; 679 tooling tests passed (`.scratch/wp2-baseline.log`). Intermediate focused run: 3 files/26 tests passed. Subsequent whole-unit runs passed 164 files/2,988 tests each. Prior browser runs also passed: `20261115T124829Z-0bad9c6f` (19), `20261115T125655Z-2bc74f67` (19), `20261115T130005Z-2501fbd0` (21). Source changes after those runs were rechecked in the final runs above. The final dedicated keyboard spec and Add-focus assertion are included in the 21-test run.

No separate API, auth, scanner-model, operations, full/hosted/sharded suite, deployment or live-data validation was run. These are unrun, not passes. The selected local browser command uses the explicitly requested shard 1/1 and one worker.

## Screenshot artifacts

All paths below are relative to this worktree, copied from the final browser run's retained artifacts. The screenshots were visually inspected; phone dialogs/toast clear the tabs.

- `.scratch/wp2-screenshots/selection-desktop.png` (1280×800)
- `.scratch/wp2-screenshots/move-desktop.png` (1280×800)
- `.scratch/wp2-screenshots/undo-phone.png` (375×812)
- `.scratch/wp2-screenshots/add-1280.png`
- `.scratch/wp2-screenshots/add-375.png`

## Files and limitations

Production/fixture changes: `web/src/games/riftbound/{collection.ts,CollectionWrites.tsx,CollectionView.tsx,RiftboundApp.tsx,local/collectionFixtures.ts,local/main.tsx}`. Tests: game-owned `collectionWrites.test.ts` and `web/tests/riftbound-collection-writes.spec.ts`. Docs: this handoff, collection-slice.md and parity-map.md. No backend, API, auth, storage, Pokémon or shared UI/shell/workspace file changed.

No unresolved implementation decision remains. The planner explicitly corrected the original version-based Undo incompatibility rule to match core. The venv fallback is the only setup deviation. Synthetic safe-integer quantities are not a real decimal-string HTTP adapter; key retention/state is in-memory and disappears on reload. Location management is WP3; batch Add, Put away, commit-without-undo, promises and Decks are omitted. This implementation does not satisfy the real-API criteria for #662. Primary-owned independent review remains required; this report is not self-approval.
