# Retrospective environment improvements — 2026-10-07

Implemented on `codex/mvp-integration` following the user's authorization to apply all six retrospective candidates. No domain behavior or provider selection changed.

- Husky installs a staged Prettier, type/generated-contract and database-free privacy test hook. Git's local hooksPath points to `.husky/_`. The repository now has a push/pull-request verification workflow with a disposable PostgreSQL service and retained synthetic diagnostics; remote CI execution and protected-branch settings are not claimed as local proof.
- `npm run verify` checks current working-tree source in a copied workspace with a newly created database, six distinct ports, per-run logs/browser output and owned cleanup. The default gate includes recovery/release-runtime tests. Browser/auth/operations modes provide shorter reproduction commands.
- Runtime regressions build historical/current artifacts into temporary stores. Their integrity receipts are explicitly synthetic test fixtures, not authoritative CI attestations. Ordinary verification checks proxy isolation, key redaction, missing schema/stale signup readiness, actual activation/rollback, preserved private data and tamper rejection. Only the expensive exact-commit predecessor/successor full drill remains opt-in.
- An AST checker rejects private release HTTP bypasses (including import aliases), unsafe proxy/redirect helper setup, dynamic ReleaseError messages, and raw external exceptions in diagnostics. Eight database-free positive/negative cases pass.
- Tracker guidance separates active implementation criteria from historical production requirements and a launch checklist. AGENTS.md adds only a navigation pointer to the verification reference.
- The previously missing writing-for-agents skill is now installed at its documented local path and was read for this work; no duplicate/global skill file was created.

## Verification

Two concurrent isolated runs passed application checks without database, port, build or log collisions: 80 API tests and 14 auth tests in each, with 21 browser journeys in the full run and one mobile journey in the selected run. Both initially exposed the same new historical-fixture setup error, whose retained diagnostics were used to correct the fixture.

A corrected full run `20261008T045830Z-5d53c6a1` passed 80 API, 14 auth, 21 browser and ten recovery/release tests (one explicit full-drill skip). A subsequent focused auth run `20261008T050016Z-ab426261` passed all 14 auth tests after direct child-process cleanup was added. The extended runtime fixture then passed all ten operations tests in `20261008T050444Z-e19bbafd`, including actual activation, rollback and tamper rejection, with one explicit full-drill skip. A fixture Location ID omission and an out-of-store symlink were corrected without changing production constraints. All runs removed their owned databases/workspaces/processes. Run names are UTC; local date is 2026-10-07.

The new pre-commit hook is exercised by the completion commit. Generated client files stay generator-owned and are excluded from Prettier. Hosted CI execution requires pushing the workflow; required-check branch protection remains a host setting.
