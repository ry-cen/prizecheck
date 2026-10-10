# Edition compatibility policy review

Reviewed on 2026-10-08 by the scoped architect who performed the earlier [read-only audit](edition-marketplace-compatibility-audit.md). The primary integrated the report. Scope: [accepted compatibility resolution](../resolutions/23-decide-marketplace-metadata-separation.md), active/historical ticket criteria, [scope ADR](../../../../adr/0007-edition-marketplace-metadata-boundary.md) and export metadata cross-reference. No new database attempts, application edits or child delegation occurred.

## Outcome

No findings or policy-closure blockers. The reviewer confirmed physical/lookup separation with conservative unknown-field handling; proven one-to-one correspondence with preserved IDs/references; reviewed ambiguous collisions without automatic merges/reassignment; override/move/Undo/public-content preservation; invalidation of changed mappings and cached quote use; complete export fallback with independent Live verification; and honest unknown persisted impact.

The owner-approved actual-datastore preflight and reviewed correction plan are mandatory before selecting or executing a correction. Closing this decision selects only the conditional planning policy and does not claim a census or migration is complete. Active/historical criteria and ADR capture that boundary explicitly.

## Requirements retained for the handoff

- `/to-spec` and later implementation: target-datastore census, compatibility storage/alias representation, reviewed correction procedure, atomicity/recovery and regression evidence. These must account for references outside current Holdings.
- [Export metadata provenance and correction](https://github.com/ry-cen/tcg-tracker/issues/43): initial/replacement mapping verification evidence, provenance, correction responsibility and maintenance. Changed mappings remain ineligible pending catalog-maintainer verification under the accepted policy.
- [Published Deck prices and snapshot compatibility](https://github.com/ry-cen/tcg-tracker/issues/39): public coordination/storage, legacy snapshot compatibility, revocation and version-safe totals using reviewed mappings.

The local database's refused connection and small/synthetic source observations are not passing persisted-data, rollout or concurrency evidence. This was a read-only document review, not implementation or runtime testing.

## Routing and verification

Laya again selected architect for high-risk final policy review. The primary reused task `35a7e34a984b4475b714a6117b33bc4b` with a new review attempt `52dba2deb93f4d139478c14474fb7341`; the earlier audit attempt remains separately recorded. Terminal review outcome is success with validation not applicable for read-only policy review.

The primary checked planning links and dependency cycles. No application verification suite applies to these Markdown-only policy additions. No database change, feature spec, implementation tickets, commit or push occurred.
