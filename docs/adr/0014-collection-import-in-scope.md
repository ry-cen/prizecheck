# Collection import from other trackers is in scope

**Status:** accepted — owner decision, 2026-10-15.

The [MVP spec](../planning/tcg-collection-tracker/spec.md) excluded "Import/export". On 2026-10-15 the owner asked for collection import "so people can move in from other trackers", because it matters most once signup is public. The [collection import map](../planning/collection-import/wayfinder/map.md) charted it.

**Decision.** A collector can bring their collection over from another tracker by uploading its CSV export or pasting a list. The boundaries the owner chose:

- **Import only.** Exporting the Collection stays out of scope.
- **An additive move-in, not a sync.** An import only adds Holdings, all into one chosen Storage Leaf. It never changes or removes existing ones, and keeps no link to the other tracker.
- **No undo.** A review in which every row is matched or skipped is the safety net. Once saved, the copies are ordinary Holdings, so saving is idempotent.
- **What's kept.** Each card, its finish and its quantity. Condition, grade, price paid and notes are dropped, so the MVP's exclusion of grading and purchase history stands.
- **One import holds at most 10,000 rows and 5 MB.**

**Consequences.** The import gets its own server-held review draft and a 5 MB upload route, the only route above the gateway's normal body limits. It never starts a catalog pull and never counts as a price access. The [contract resolution](../planning/collection-import/wayfinder/resolutions/decide-collection-import-contract.md) holds the details.
