# Research — Reconcile the workspace tickets with dev

**Ticket:** [Reconcile the workspace tickets with dev](https://github.com/ry-cen/prizecheck/issues/136)

**Gathered:** 2026-10-12, against `dev` at `70fb46e`. Each acceptance criterion of the 13 collector workspace tickets was checked against the code, tests and evidence there. Nothing was run in this audit. The run evidence is the full gate recorded on the workspace merge commit `60e8be7` in [Collector workspace](https://github.com/ry-cen/prizecheck/pull/115): pytest 950 passed and 8 skipped, vitest 76 passed, Playwright 150 passed, operations 11 OK.

**`dev` head is red.** The newest commit, `fcc2939` ("Plan the Deck List trigger for each statement's rows", migration 039), fails the fast tier in CI. It changes only the Deck List trigger and `api/tests/test_deck_list_moves.py`, not workspace code. The cause sits in the run's `verification` artifact, which wasn't read for this audit.

## Summary

- **All 13 tickets are delivered on `dev`.** Every acceptance criterion is met in code, and every named test exists and asserts the behaviour. A few coverage gaps are listed below. None of them is a missing behaviour.
- **What is open is launch acceptance, not implementation.** The [collector workspace launch checklist](https://github.com/ry-cen/prizecheck/blob/dev/docs/planning/collector-workspace/launch-checklist.md) is still `pending`: the load proofs, real-device and cross-browser checks, screen readers and the owner walkthrough. #114 asked only that these be recorded there, and they are.
- **The app redesign starts from the workspace as built.** It replaces the parts listed under [What the app redesign supersedes](#what-the-app-redesign-supersedes).
- **Two findings the redesign spec must settle:** card category has two sources, and Pick List Undo can evict Collection's Undo. See [What is actually left](#what-is-actually-left).
- The tickets stay open. Per the tracker, they close when `dev` reaches `main`, and closing them is the owner's call.

## What is actually left

### For the redesign spec

1. **Card category and type have two sources.** The Collection filter reads `catalog_printing_metadata.category` and `elemental_types` (`api/app/collection.py:153,292-295`, migration 027). Format checks, reviewed corrections and the public catalog read `catalog_card_attribute.card_kind` (`api/app/format_evaluator.py:678`, `attribute_corrections.py`, `public_catalog.py:843`). A reviewed correction therefore changes format results but not the Collection filter. The deck builder's library chips and Catalog's type chips need one source. This belongs with [Decide the deck builder, Catalog and public data contracts](https://github.com/ry-cen/prizecheck/issues/138).
2. **Pick List Undo still uses single-source records.** `api/app/deck_pick_list.py:9-17,292-296` writes one single-source Undo record per source and caps a confirmation at five sources (`MAX_PICK_SOURCES`), because Inventory Undo keeps only the newest five records per owner (`api/app/moves.py:323,339`). The code's own comment says it should move to the multi-source path. Until it does, a Gather confirmation can push all of Collection's Undo history out. The deck experience decision plans batches of five, which works around the cap but not the eviction. This also belongs with #138.

### Small cleanups

- `getLocations` and `getCatalogStatus` in `web/src/generated.ts:24-26` have no callers left.
- `browser.spec.ts:13`, `catalog-search.spec.ts:35` and `collection.spec.ts:21-24` still enter through `/locations`, which now redirects. No test asserts the redirect itself.
- The 027 backfill covers only Printings with a stored source record. The launch checklist already says to run a catalog pull after deploying.

### Coverage gaps (behaviour present, not asserted)

| Ticket | Gap |
| --- | --- |
| [#105](https://github.com/ry-cen/prizecheck/issues/105) | Ctrl/Cmd-marquee is tested only on mounted rows. The plain marquee across unmounted rows is tested. |
| [#106](https://github.com/ry-cen/prizecheck/issues/106) | No test sends 501 items or expects manifest expiry. Key reuse is tested for Move, not Removal. The migration-compatibility test seeds old-shape rows instead of running 026. |
| [#107](https://github.com/ry-cen/prizecheck/issues/107) | No browser test moves into a Deck through the explorer. |
| [#109](https://github.com/ry-cen/prizecheck/issues/109) | Edge auto-scroll during a handle drag is untested, and the floating label's position isn't checked. |
| [#111](https://github.com/ry-cen/prizecheck/issues/111) | The ≤64-Editions-per-request assertion is vacuous, because the fixture never mounts more than 64 tiles. |
| [#103](https://github.com/ry-cen/prizecheck/issues/103) | Scroll smoothness at 25,000 Holdings has no recorded check. The test bounds mounted tiles at ≤400. |

## Per ticket

| Ticket | Status | Evidence and notes |
| --- | --- | --- |
| [Workspace shell, design variables and Location sidebar](https://github.com/ry-cen/prizecheck/issues/102) | Delivered | `web/src/tokens.css` (one Prize gold theme on `data-theme`), `workspace/locationTree.ts` (natural, case-insensitive collator), `workspace-shell.spec.ts`. The criterion "the Locations view keeps working" was intentionally reversed by #114. The theme attribute sits on `<html>` (`web/index.html:2`). |
| [Holding-level collection read and the tile gallery](https://github.com/ry-cen/prizecheck/issues/103) | Delivered | `GET /api/collection/holdings` (`api/app/collection.py:259-334`), `test_collection_holdings.py`, `galleryModel.ts`, windowing in `Gallery.tsx`, `workspace-gallery.spec.ts` including the `@slow` 25,000-row test. |
| [Search, filters, sort and display preferences](https://github.com/ry-cen/prizecheck/issues/104) | Delivered | Migration 027 with backfill, `test_card_category.py`, `test_collection_holding_filters.py`, `galleryPrefs.ts` (per-user localStorage, search not stored), `workspace-filters.spec.ts`. Later work added anchored cursors; the criteria still hold. |
| [Selection, inspector and mobile Select mode](https://github.com/ry-cen/prizecheck/issues/105) | Delivered | `selectionModel.ts`, `useSelection.ts`, `Selection.css`, `Inspector.tsx`, `workspace-selection.spec.ts` (gestures, unmounted rows, precedence, keyboard, 375×812 Select mode with a CDP touch swipe). Real touch is a checklist item. |
| [Atomic multi-source Move, Removal and Undo API](https://github.com/ry-cen/prizecheck/issues/106) | Delivered | `api/app/moves.py`, migration 026, `test_multi_source_moves.py` (each item in the spec's API test list, plus the five-source 25,000-Edition load test under 120 s), `test_inventory_undo.py`. The MVP spec points to the new contract (`docs/planning/tcg-collection-tracker/spec.md:126,141,170`). |
| [Move, Inventory Removal and Undo from the workspace](https://github.com/ry-cen/prizecheck/issues/107) | Delivered | `InventoryDialogs.tsx`, `tileDrag.tsx`, `UndoToast.tsx`, `workspace-actions.spec.ts` (explorer Move across sources, drag, Removal, Undo, unavailable Undo, failures, keyboard-only, mobile sheets). Dragging an unselected tile also makes it the selection, which the ticket doesn't specify. |
| [Location creation from the sidebar](https://github.com/ry-cen/prizecheck/issues/108) | Delivered | `CreateLocationDialog.tsx`, `LocationNav.tsx`, `workspace-location-create.spec.ts` (root, child, both conversions, Cancel, inline errors, depth). |
| [Manage locations panel](https://github.com/ry-cen/prizecheck/issues/109) | Delivered | `ManageLocations.tsx`, `manageLocationsModel.ts`, `workspace-manage-locations.spec.ts` (mouse and CDP-touch drags, invalid targets including 12 levels and Decks, picker by tap and keyboard, conversion, Rename, Delete, stale edit from a second tab). Safari and Firefox are checklist items. |
| [Deck rename and move](https://github.com/ry-cen/prizecheck/issues/110) | Delivered | `api/app/decks.py:132-134` through the shared `location_tree.apply_edit`, `test_deck_edit.py` (every listed case), `editDeck` client, and the Deck case in `workspace-manage-locations.spec.ts`. Deck deletion has since landed on `dev` (`api/app/deck_deletion.py`, ADR 0009), but the workspace still disables Delete on Decks. |
| [Prices in the inspector and on tiles](https://github.com/ry-cen/prizecheck/issues/111) | Delivered | `Inspector.tsx`, `EditionPrice.tsx` batching (64 per request, two in flight), Prices toggle in `galleryPrefs.ts`, `workspace-prices.spec.ts`. |
| [Deck cost and exports in the Deck heading](https://github.com/ry-cen/prizecheck/issues/112) | Delivered | `workspace/DeckHeading.tsx` reuses `DeckCost`, `DeckLiveExport` and `DeckMassEntryExport` over `getDeck`. `Decks.tsx:145-148` has the Open in workspace link. `workspace-deck-heading.spec.ts`. |
| [Stale-collection banner](https://github.com/ry-cen/prizecheck/issues/113) | Delivered | `useStaleCollection.ts` (BroadcastChannel plus a focus and visibility probe), `StaleBanner.tsx`, `workspace-stale.spec.ts` (second tab, second session on focus, safe failure, Reload note). |
| [Cutover, accessibility pass and prototype removal](https://github.com/ry-cen/prizecheck/issues/114) | Delivered | `/workspace` is the default page, with `/` and `/locations` redirecting (`web/src/main.tsx:35-41,352`). The old Locations view and its tests were removed in `a95fdc2`. The prototype was removed in `7305358`, and no prototype code remains in `web/src`. `workspace-accessibility.spec.ts` runs axe at WCAG 2.2 AA and checks focus, keyboard, 44 px targets, reduced motion and token contrast. The gate passed on `60e8be7`. Manual checks are recorded in the launch checklist. |

## What the app redesign supersedes

These were delivered as specified, and the redesign decisions now replace them. The spec should say what changes rather than treat them as missing.

- **Route and name (#102, #114).** `/workspace` becomes Collection at `/collection`, and `/workspace` and `/locations` redirect there ([map Notes](../map.md#notes)). The old Collection page that still opens at `/collection` on `dev` is retired ([audit](../resolutions/audit-old-collection-page.md)). This reverses the checklist's "`/collection` … stay[s]" and its "`/collection` still opens" manual check.
- **Header and drawers (#102, #104).** The workspace's own PrizeCheck header becomes the shell: top tabs and an avatar menu on desktop, a bottom tab bar on mobile. On mobile, ☰ opens the Locations drawer, and Search and Filters & display become page header controls ([app shell](../resolutions/decide-app-shell.md)). Mobile Select mode placement is explicitly not superseded yet.
- **Pages keep their state.** Returning to Collection restores its Location, selection, scroll, search, filters and display choices without placeholder flashes. This changes the #105 rule that leaving clears the selection when you switch tabs, though a reload still starts fresh. It also covers [Workspace flashes gray placeholder tiles and jumps in size on every Location switch](https://github.com/ry-cen/prizecheck/issues/121).
- **Inspector (#105).** The inspector gains the per-Leaf breakdown of copies owned, and every Card Edition gains its Variant Descriptor ([audit](../resolutions/audit-old-collection-page.md)).
- **Add cards (#114).** `workspace/AddCardsDialog.tsx` and `AddCardsForm.tsx` are replaced by Catalog's Add mode, opened from Collection ([Catalog search](../resolutions/decide-catalog-search.md)).
- **Deck heading and Decks page (#112).** Deck building, Export, Publish and Delete move to the Decks page's deck builder. In Collection, an open Deck keeps its Holdings with Move, Remove and Undo. A banner shows the cost and links to the Deck on Decks ([deck experience](../resolutions/decide-deck-experience.md)). The decision names only cost and the link, so whether Collection keeps its Export menu is for the spec to settle. Buy missing defaults Mass Entry to the cards you don't own. The Decks page's Open in workspace link and its Holdings panel (`Holdings.tsx`, `MoveHoldings.tsx`, which `Decks.tsx` still renders) give way to the deck builder.
- **Deck deletion (#110).** #110 left it out of scope. The deck builder's header now has Delete, backed by the `dev` route.
