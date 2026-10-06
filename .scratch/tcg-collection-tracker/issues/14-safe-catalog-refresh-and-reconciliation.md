# 14 — Safe catalog refresh and reconciliation

**Label:** ready-for-agent

**Blocked by:** 02 — First English catalog pull; 13 — Missing-card reports and approval

**Status:** in-progress

**What to build:** The owner can refresh an established English catalog while source drift and possible matches to manual records are held for review instead of silently changing physical identities.

- [ ] A refresh re-enumerates complete source IDs and blocks unsafe promotion on failed fetch, mismatched enumeration, duplicate reference, descriptor collision, source-ID drop over 1%, or chosen-database capacity gate. The current searchable generation remains active on failure.
- [ ] Source name changes that alter Card Identity and ambiguous variant changes enter an owner review queue. Valid independent changes may promote atomically with a revision and last-success time.
- [ ] Two agreeing complete enumerations can tombstone a source record; owned Editions retain immutable identity/display data and reject new Adds. Manual records are never tombstoned merely for upstream absence.
- [ ] A possible later TCGdex match to a manual record requires owner confirmation of physical identity before a source reference is linked. No automatic merge, replacement, or Holding reassignment occurs; corrections deprecate and link replacements for explicit collector reassignment.
- [ ] API/job/PostgreSQL tests cover changed names, ambiguous descriptors, failed refresh rollback, tombstones, manual record survival, later matches, and revision-bound search cursors.

## Implementation evidence

Implemented source-ID/descriptor safety, preserved ambiguous established Editions, immutable Printing display snapshots, manual/source candidates, owner decisions bound to fresh email codes, evidenced source-reference links, complete Printing/Edition replacement mappings, and explicit collector quantity reassignment with versions and idempotency. No refresh or owner decision changes Holdings. All 61 merged API/PostgreSQL regressions pass in the isolated database; TypeScript/build and generated-client checks pass. Exact-run runner changes from ticket19 are merged and preserved. Public snapshots use immutable Printing display metadata. Browser review/code test awaits the integrated owner-panel gate.
