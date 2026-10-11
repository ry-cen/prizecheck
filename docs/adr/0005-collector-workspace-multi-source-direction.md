# Collector workspace multi-source inventory direction

**Status:** accepted — owner instruction, 2026-10-09. Implemented: the [collector workspace spec](../planning/collector-workspace/spec.md) ([#79](https://github.com/ry-cen/prizecheck/issues/79)) defined the multi-source contract, and the workspace became the signed-in inventory page in [#114](https://github.com/ry-cen/prizecheck/issues/114).

The owner approved a redesigned collector workspace in which visual selection may span multiple source Storage Leaves. The canonical product requirements are in the linked workspace resolution.

This began as a scope direction, not a change to the MVP implementation contract. The MVP specification, generated client, API Move manifest and Undo flow used one `source_id` per Move or Removal, and that behavior stayed authoritative until a backend decision and specification revision defined migration, concurrency, idempotency, response, persistence and verification details. The collector workspace spec resolved [Decide atomic multi-source inventory operations](https://github.com/ry-cen/prizecheck/issues/49); its [multi-source Move, Removal and Undo decisions](../planning/collector-workspace/spec.md#multi-source-move-removal-and-undo-resolves-49) are implemented and now authoritative. Single-source manifests and existing single-source Undo records remain supported.

Alternatives considered: retaining single-source selection would avoid contract changes but does not meet the approved workspace behavior; durable per-copy records would make selection explicit but conflicts with the retained fungible Holding model. The accepted direction retains Holding quantities and adds no copy-specific fields or IDs.

Organizational Locations remain unable to hold cards. Decks remain physical Storage Leaves and eligible destinations. Dedicated deck-building UI is deferred.

See [the canonical workspace resolution](../planning/tcg-collection-tracker/wayfinder/resolutions/29-decide-collector-workspace-selection-and-presentation.md) and [the backend decision](https://github.com/ry-cen/prizecheck/issues/49), resolved by the [collector workspace spec](../planning/collector-workspace/spec.md).
