# 14 — Safe catalog refresh and reconciliation

**Label:** ready-for-agent

**Blocked by:** 02 — First English catalog pull; 13 — Missing-card reports and approval

**Status:** complete

**What to build:** The owner can refresh an established English catalog while source drift and possible matches to manual records are held for review instead of silently changing physical identities.

- [x] A refresh re-enumerates complete source IDs and blocks unsafe promotion on failed fetch, mismatched enumeration, duplicate reference, descriptor collision, source-ID drop over 1%, or chosen-database capacity gate. The current searchable generation remains active on failure.
- [x] Source name changes that alter Card Identity and ambiguous variant changes enter an owner review queue. Valid independent changes may promote atomically with a revision and last-success time.
- [x] Two agreeing complete enumerations can tombstone a source record; owned Editions retain immutable identity/display data and reject new Adds. Manual records are never tombstoned merely for upstream absence.
- [x] A possible later TCGdex match to a manual record requires owner confirmation of physical identity before a source reference is linked. No automatic merge, replacement, or Holding reassignment occurs; corrections deprecate and link replacements for explicit collector reassignment.
- [x] API/job/PostgreSQL tests cover changed names, ambiguous descriptors, failed refresh rollback, tombstones, manual record survival, later matches, and revision-bound search cursors.

## Implementation evidence

Implemented source-ID/descriptor safety, preserved ambiguous established Editions, immutable Printing display snapshots, manual/source candidates, owner decisions bound to fresh email codes, evidenced source-reference links, complete Printing/Edition replacement mappings, and explicit collector quantity reassignment with versions and idempotency. No refresh or owner decision changes Holdings. All 61 merged API/PostgreSQL regressions pass in the isolated database; TypeScript/build and generated-client checks pass. Exact-run runner changes from ticket19 are merged and preserved. Public snapshots use immutable Printing display metadata. Browser review/code test awaits the integrated owner-panel gate.

## Final integration validation — 2026-10-06

Closed on `codex/mvp-integration` after the combined gate at `859f2aa`: 68 API/PostgreSQL tests, six live authentication tests, and 19 Chromium browser tests passed, along with migrations, generated contracts, TypeScript and build. Independent Standards/Spec review findings are resolved. See [integration evidence](../evidence/integration-validation.md) and [review resolutions](../evidence/code-review.md). Production provider, capacity and launch proof remains tracked by tickets 15–18; this closure records application implementation and local validation.
