# Resolution — Old Collection page audit

**Ticket:** [Audit the old Collection page against Collection](https://github.com/ry-cen/prizecheck/issues/123)

**Audited:** 2026-10-12, on `feature/app-redesign` at `6507500`

**Question:** Does Collection (the renamed workspace, `web/src/workspace/`) cover everything the old Collection page (`web/src/Collection.tsx`, the `collection` view in `web/src/main.tsx`) does, so that the old page can be retired?

## Answer

Almost. Collection covers or replaces every capability except two that the [tracker spec](../../../tcg-collection-tracker/spec.md) requires:

1. **Variant Descriptor.** Collection never shows a Card Edition's Variant Descriptor or the Unspecified Variant label. Tiles, tile labels and the inspector all leave it out. Two Editions of one Printing, such as holo and reverse holo, look and read the same, apart from the price. This breaks user story 14 ("uncertain variants labeled Unspecified Variant") and the spec's rule that the product must show variant uncertainty.
2. **Edition distribution.** The old page's "Find copies" lists each Storage Leaf that holds an Edition, with its quantity (user story 62). The Collection inspector shows only "N copies here" and "N copies owned". It reads the same distribution endpoint but shows just the sum. In the All view, an Edition's Holdings sit next to each other and each tile's inspector shows its Location path, so you can find every copy, but only one tile at a time.

The owner's decisions on these gaps are under [Owner decisions](#owner-decisions).

## Capability by capability

| Old page capability | Collection | Status |
| --- | --- | --- |
| Lists everything owned, across all Locations | The All view (`galleryModel.ts` `queryToParams`, no `location_id`) | Covered |
| Scoped to one Location (`locationId` prop) | Location views in the sidebar | N/A: dead code. `main.tsx:343` renders `<Collection />` with no props |
| Name filter (`name`, substring) | Debounced search box (`GalleryQuery.search` → `name`, the same `LIKE` match in `api/app/collection.py:288`) | Covered |
| Set filter (free-text `set_id`) | Set filter, a list of owned sets (`/api/collection/sets`) | Covered, and easier to use |
| Collector number filter (exact match) | None. Collection sorts by set and number (`set-asc`/`set-desc`), and the Names toggle shows set and number on a second line (workspace spec story 109) | Gap, minor. The workspace spec (line 200) left it out on purpose. The spec's story 12 (search by set and collector number) is met by Catalog search (`CatalogSearch.tsx:197,222`) |
| Sort by name | `name-asc` / `name-desc` | Covered |
| Sort by "Most copies" (Edition total) | `quantity-desc` / `quantity-asc` sort by `edition_total`, the Edition's total in the current view (`api/app/collection.py:186`) | Covered |
| One entry per Edition, with its total quantity (story 61) | One tile per copy, with an Edition's Holdings next to each other. The inspector shows "N copies owned" across all Locations (`Inspector.tsx` `useOwnedTotal`) | Replaced by the owner-confirmed workspace design ([resolution 29](../../../tcg-collection-tracker/wayfinder/resolutions/29-decide-collector-workspace-selection-and-presentation.md)) |
| Card art, with "Artwork unavailable" when the image fails | Tile art falls back to the card name (`Gallery.tsx` `TileArt`); the inspector has `DetailsArt` | Covered |
| Printing name, set name and collector number | Tile hover title and accessible name (`galleryModel.ts:317,325`), the Names toggle, and the inspector | Covered |
| Variant Descriptor / Unspecified Variant | Not shown anywhere in `web/src/workspace/` | **Gap: spec requirement** |
| Price per Edition (`EditionPrice`) | Prices toggle on tiles (`Gallery.tsx:556`, compact) and the full price in the inspector (`Inspector.tsx` `InspectorPrice`) | Covered |
| "Find copies": per-Leaf distribution dialog | Inspector total only. The per-Leaf breakdown isn't shown | **Gap: spec requirement** |
| Paging ("More owned cards", 30 per page) | Virtualised gallery that loads pages automatically (`useGalleryData.ts`) | Covered |
| Inventory or catalog changed mid-walk, so restart from page one | `useGalleryData.ts:19` restarts on `INVENTORY_CHANGED`/`CATALOG_CHANGED`, plus the stale-collection banner (`StaleBanner.tsx`) | Covered |
| "Collection is temporarily unavailable. Retry." | Gallery error with a Retry button (`Gallery.tsx:409`) | Covered |
| Empty: "No owned Editions match." | `ws-gallery-empty` with a per-view message (`Gallery.tsx:414`) | Covered |

## What retiring the page touches

These aren't gaps. They are cutover facts for the spec:

- The `/collection` route, the old shell's "Collection" nav item (`main.tsx:235,247,342`) and Collection's own `AppPage` "collection" link (`Workspace.tsx:59-61`) all point at the old page today. Under [the shell decision](decide-app-shell.md), "Collection" means the workspace at `/collection`.
- Keep `web/src/Holdings.css`. `Collection.tsx` imports it, but so does `Holdings.tsx`, which `Decks.tsx` still uses.
- Keep `GET /api/collection/editions/{id}`. The Collection inspector reads it.
- `GET /api/collection` (the per-Edition listing) has no web caller apart from the old page. API tests still use it: `api/tests/test_collection.py`, `test_local_capacity.py:45` and `test_deck_lists.py:224-229`. Removing it is a follow-on cleanup and doesn't block retirement.
- [Workspace: Cutover, accessibility pass and prototype removal](https://github.com/ry-cen/prizecheck/issues/114) retires the old Locations and Holdings views but doesn't mention the old Collection page. Retiring it belongs to this redesign.

## Owner decisions

**Owner confirmed:** 2026-10-12

- **Retire the old Collection page.** Collection replaces it at `/collection`, and the old component and its view are removed during the cutover.
- **Collection shows the Variant Descriptor.** Each Card Edition's Variant Descriptor, or "Unspecified Variant", appears in Collection, including in tile accessible names and the inspector. This goes into the redesign spec. Exactly where it sits on a tile is a layout detail for the spec and the shared component kit.
- **The inspector lists the per-Leaf breakdown.** "N copies owned" expands into each Storage Leaf that holds the Edition, with its quantity and Location path. The data comes from the distribution read the inspector already makes. This goes into the redesign spec.
- **No collector-number filter.** Sorting by set and number, the Names line and Catalog search's number filter are enough.
- ~~Removing `GET /api/collection` and its tests is optional follow-on cleanup.~~ **Superseded:** [the Deck experience resolution](decide-deck-experience.md) keeps this route as the likely source for the deck builder's owned library.
