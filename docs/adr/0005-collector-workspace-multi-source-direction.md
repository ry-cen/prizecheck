# Collector workspace multi-source inventory direction

**Status:** accepted future scope — owner instruction, 2026-10-09.

The owner approved a redesigned collector workspace in which visual selection may span multiple source Storage Leaves. The canonical product requirements are in the linked workspace resolution.

This is a scope direction, not a change to the current MVP implementation contract. The MVP specification, generated client, API Move manifest, and Undo flow currently use one `source_id` per Move/Removal. Their current behavior remains authoritative until a separate backend decision and specification revision define migration, concurrency, idempotency, response, persistence, and verification details.

Alternatives considered: retaining single-source selection would avoid contract changes but does not meet the approved workspace behavior; durable per-copy records would make selection explicit but conflicts with the retained fungible Holding model. The accepted direction retains Holding quantities and adds no copy-specific fields or IDs.

Organizational Locations remain unable to hold cards. Decks remain physical Storage Leaves and eligible destinations. Dedicated deck-building UI is deferred.

See [the canonical workspace resolution](../planning/tcg-collection-tracker/wayfinder/resolutions/29-decide-collector-workspace-selection-and-presentation.md) and [the pending backend decision](https://github.com/ry-cen/tcg-tracker/issues/49).
