# Complete the remaining MVP implementation without provider selection

**Status:** accepted — owner instruction, 2026-10-06.

The owner requested continuing through ticket 18 and then explicitly directed: “can we just forget the provider issue and work provider agnostic”. Provider selection is no longer a prerequisite for completing the remaining application and operational implementation. No production accounts, services or domain are to be provisioned by this change.

Implement concrete portable boundaries for email delivery, private backups, independent monitoring, owner status, exact-commit manual releases/rollback, and gated public signup. Local executable adapters and real disposable PostgreSQL/process/HTTP/email-protocol tests establish implementation behavior. Configuration supplies deployment locations, credentials, scheduling and quotas without hardcoding a vendor.

Ticket 15 resolves as this scope decision. Tickets 16–18 close when their revised provider-independent implementation criteria pass. Original production acceptance requirements remain in a separate launch checklist: real sending-domain and recipient validation, selected-runtime performance/cost and complete English catalog, private remote recovery, independent notification delivery, production release/rollback and the owner's walkthrough. Local evidence must identify its actual environment and cannot be recorded as those production proofs. Public signup remains closed by default and requires an explicit readiness/configuration gate before production activation.

This supersedes the provider-selection dependency in ADR 0002 and tickets 15–18; it preserves domain semantics, privacy, atomicity and recovery requirements. Production launch and provisioning remain separate work.
