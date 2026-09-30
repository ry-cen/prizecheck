# 13 — Missing-card reports and approval

**Label:** ready-for-agent

**Blocked by:** 01 — Owner sign-in and Unsorted; 03 — Collector catalog search

**Status:** ready-for-agent

**What to build:** A signed-in collector can privately report a missing English Card Printing or Card Edition, and the owner can approve an evidenced shared record that becomes searchable immediately.

- [ ] Reporters see only their own report state; submission never publishes a catalog record. The owner can request information, reject, approve, or begin a record directly.
- [ ] Approval of a Printing requires verified set, collector number, exact English name, and evidence link. Edition approval requires evidence of a distinct physical Variant Descriptor; uncertainty uses Unspecified Variant.
- [ ] Every review API derives the immutable owner ID from the verified session. Sensitive identity approval requires a fresh single-use email code bound to that specific owner/action and rejects replay.
- [ ] Approval writes immutable application IDs, manual provenance, reviewer/time/evidence/reason, and a new catalog revision in one PostgreSQL transaction. Search sees the record immediately after commit; missing art uses the normal placeholder.
- [ ] Browser/API/PostgreSQL tests cover private report isolation, incomplete evidence, duplicate/ambiguous candidates, fresh-code expiry/replay, immediate search visibility, cursor invalidation, and transaction rollback.
