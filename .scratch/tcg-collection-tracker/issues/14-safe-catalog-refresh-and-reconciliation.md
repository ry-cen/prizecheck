# 14 — Safe catalog refresh and reconciliation

**Label:** ready-for-agent

**Blocked by:** 02 — First English catalog pull; 13 — Missing-card reports and approval

**Status:** ready-for-agent

**What to build:** The owner can refresh an established English catalog while source drift and possible matches to manual records are held for review instead of silently changing physical identities.

- [ ] A refresh re-enumerates complete source IDs and blocks unsafe promotion on failed fetch, mismatched enumeration, duplicate reference, descriptor collision, source-ID drop over 1%, or chosen-database capacity gate. The current searchable generation remains active on failure.
- [ ] Source name changes that alter Card Identity and ambiguous variant changes enter an owner review queue. Valid independent changes may promote atomically with a revision and last-success time.
- [ ] Two agreeing complete enumerations can tombstone a source record; owned Editions retain immutable identity/display data and reject new Adds. Manual records are never tombstoned merely for upstream absence.
- [ ] A possible later TCGdex match to a manual record requires owner confirmation of physical identity before a source reference is linked. No automatic merge, replacement, or Holding reassignment occurs; corrections deprecate and link replacements for explicit collector reassignment.
- [ ] API/job/PostgreSQL tests cover changed names, ambiguous descriptors, failed refresh rollback, tombstones, manual record survival, later matches, and revision-bound search cursors.
