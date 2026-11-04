# Frontend boundary assessment: what is left after #453 and #447

**Status:** assessment for [#532](https://github.com/ry-cen/prizecheck/issues/532), read from `dev` at `41ffcbab` on 2026-11-04. It authorizes no code. Each slice below still needs its own ticket and approval, as [frontend composition](frontend-composition.md) requires.

## Result

Four small slices are ready to specify, and none needs a framework. Each follows the existing pattern: the Pokémon values move into `web/src/games/pokemon/`, shared code keeps the mechanics, and one listed composition point joins them.

Collection facets come first: they are the largest block of Pokémon values in shared code, they sit in five files, and #478 and #526 touch none of them. The Variant and Catalog slices can follow in either order. Export names come last of the four.

Scanner moves, client base paths and shell or routing changes get no slice. They depend on the decisions at the end of this document.

## Already done, so excluded

- Formats, standing words and tones (`games/pokemon/formats.ts`) and Deck List grouping (`games/pokemon/deckGroups.ts`), from #453.
- Kept pages and preloading (`shell/keptPages.ts`, `shell/keptRead.ts`, `preloadShellPages`), from #447. They hold no game values, and nothing here changes them.
- The existing checks: `scripts/check_web_boundaries.py`, `scripts/web_boundary_allowlist.txt` and `scripts/check_bundle_boundary.py`. No slice needs a new check.

The note in frontend composition that facets and shell work "overlap PR #447" is out of date, since #447 has merged. The active overlaps are in [Overlap and sequencing](#overlap-and-sequencing).

## Current ownership

Paths are under `web/src/`.

| Area                   | Pokémon values held in shared code                                                                                                                                                                                                                                                                                                                                                                                                                                       | Reusable mechanics that stay shared                                                                                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Collection facets      | `workspace/galleryModel.ts:39-94`: `CATEGORY_LABELS`, `TRAINER_TYPE_LABELS`, `CategoryFilter`, `TRAINER_TYPE_FILTERS`, `CATEGORY_OPTIONS`, `ELEMENTAL_TYPES`. `workspace/GalleryControls.tsx:176`: the `Elemental type` label. `workspace/Inspector.tsx:44`: `cardKindLine`.                                                                                                                                                                                              | `FilterControls`, the Set filter, sort, `activeFilterCount`, paging, totals, tile keys and labels.                                                                                                       |
| Preferences and query  | `workspace/galleryPrefs.ts:57-70` validates stored values against the Pokémon lists. `workspace/galleryModel.ts:125-131` maps a Category to `category` or `trainer_type`, and a type to `elemental_type`.                                                                                                                                                                                                                                                                 | The storage key, `parsePrefs`, `mergePrefs`, `useGalleryPrefs`, the field order of `queryToParams`, and the listing key in `useGalleryData.ts:56`.                                                       |
| Catalog facets         | `catalog/catalogText.ts:15-22` `KINDS`, used by `CatalogFilters.tsx:93` and `decks/DeckLibrary.tsx:217`. `catalog/catalogText.ts:27-28` the `PAL 185` example. `catalog/setEras.ts:16-21` `SIDE_SERIES`.                                                                                                                                                                                                                                                                  | The chip row, `searchHint`, and the era grouping in `groupSetsByEra`.                                                                                                                                    |
| Variant display        | `ui/variantLabel.ts:5-9` finish words, `:13-22` key order, `:26-35` source keys, `:85` the standard size. `collectionImport/importText.ts` `BULK_FINISHES`.                                                                                                                                                                                                                                                                                                               | Reviewed `label`, the `Unspecified Variant` term, key sorting, and word casing. 40 call lines in 28 files use `variantLabel`, including the scanner and `trades/ProposalLibrary.tsx`.                     |
| Edition identity lines | Set, number and Variant lines are not Pokémon values, but the strings repeat by hand. `set_name · number · variant` appears in `decks/wantListModel.ts:38`, `decks/deckListModel.ts:291`, `decks/surplusModel.ts:55,144`, `decks/SwapList.tsx:190` and `decks/DeckBuilderPage.tsx:351`. Five sites compare with the finish word `"Normal"`: `decks/useWantListSwap.ts:21,37`, `decks/import/importModel.ts:181,194`, `trades/tradeText.ts:26`.                                 | Other shapes are separate wording: `loans/loanText.ts:336`, `catalog/addQueue.ts:78`, `tileLabel`, `EditionTile`'s accessible name, and the owner screens. Leave them apart.                              |
| Export                 | `decks/ExportDialog.tsx:13-16` and `DeckLiveExport.tsx:149-150` name Pokémon TCG Live. The API owns these exports under `api/app/games/pokemon/exports/`. `DeckLiveExport`, `DeckMassEntryExport` and their Published forms sit at the root of `web/src`.                                                                                                                                                                                                                  | `ExportOutput.tsx`. `public/PublishedExportDialog.tsx:2` imports `EXPORT_CONTENT` from `decks/ExportDialog`, so a Published Deck reaches a private page's folder for a class string.                      |
| Scanner                | No Pokémon word in shared code outside tests. The game is in its data and tuning: `scanner/guide.ts:4` card shape, `scanner/recognize/constants.ts:24` OCR crops, `scanner/recognize/numbers.ts:114-115` number grammar, plus the models. Much of it is a port of the spike code held to parity fixtures.                                                                                                                                                                 | Camera, tray, vision, worker and asset loading. The scanner is a separate HTML entry at `/collection/scan`, reached by full navigation (`scanner/route.ts`, `shell/openScanner.ts`).                      |
| Client and routing     | None by name. `shell/routes.ts:33-91` and `shell/lazyPages.ts:125-132` describe one app. All 23 generated clients hardcode `/api/…`, and `main.tsx:117` hardcodes `/auth/session`.                                                                                                                                                                                                                                                                                        | All of it, for now. ADR 0023 keeps every `/api` path unchanged and leaves the web app and identity out of scope.                                                                                         |

Three more places hold Pokémon words outside the areas #532 lists:

- Deck Import: `decks/import/importModel.ts:63-68` section labels, `:103` `Basic Energy`, `EnergyChooser.tsx`, and `PasteStep.tsx:83`.
- Owner and report screens: `owner/attributeValues.ts:18-30` repeats `ELEMENTAL_TYPES` as `POKEMON_TYPES`, and `MetadataReport.tsx:192-194` and `MetadataReview.tsx:507-509` repeat the categories.
- Product copy: `public/LandingPage.tsx` and its legal notice. This describes the product, so it isn't a composition gap.

## Rules each slice keeps

- **One vocabulary is not the goal.** `Tools`, `Trainer · Tool`, `Tool`, `Trainer: Pokémon Tool` and `Pokémon Tool` are five deliberate forms across grouping, Catalog, Collection and the inspector. Move them as they are. Don't merge them.
- **Game inputs are static imports.** `useGalleryPrefs` reads before first render, so the first listing request already uses stored filters. A hidden kept page starts that read during preloading. A lazy game module or an async lookup would change both.
- **Stored bytes stay.** Keep the key `prizecheck:workspace:preferences:v1:<user>`, the field names `category` and `type`, and values such as `Pokemon` and `Tool`. `mergePrefs` keeps fields it doesn't know, and that stays too.
- **Query order stays.** `queryToParams` builds `location_id`, `sort`, `name`, `set_id`, `category` or `trainer_type`, then `elemental_type`. `useGalleryData` uses that JSON as its cache key and passes it on to the request.
- **Composition stays inside the lazy page.** Workspace, Catalog and Published Deck each have their own chunk boundary. `npm run check:bundle` must pass with no new lazy page, and a game value must not pull a private page into a public graph.
- **Old exports stay where a move would touch #478 files.** The pattern from `catalogText.ts` lets 28 Variant callers keep their imports.

## Ranked slices

### 1. Collection facets, preferences and query

**Files:** new `games/pokemon/galleryFacets.ts`; `workspace/galleryModel.ts`, `galleryPrefs.ts`, `GalleryControls.tsx`, `useGalleryData.ts`, `Inspector.tsx`, `Workspace.tsx`; one allow-list line, `workspace/Workspace.tsx -> games/pokemon/galleryFacets.ts`.

**Game input**, a plain required value that `Workspace.tsx` passes down:

```ts
type GalleryFacets = {
  categoryOptions: readonly { value: string; label: string }[];
  typeLabel: string; // "Elemental type"
  typeOptions: readonly string[]; // in the game's order
  filterParams(filters: GalleryFilters): CollectionHoldingQuery; // category or trainer_type, then elemental_type
  cardKindLine(holding: HoldingView): string | null;
};
```

`parsePrefs(raw, facets)`, `queryToParams(query, facets)`, `useGalleryPrefs(userId, facets)`, `useGalleryData(query, revision, facets)` and `FilterControls` take it with no default, so a missed call site fails to typecheck. Workspace is the only consumer of these controls, so nothing else changes. Sort stays shared: its words and API values are not game terms.

**Depends on:** nothing. It can start before #478 and #526 land.

### 2. Variant vocabulary behind `variantLabel`

**Files:** new `games/pokemon/variants.ts` for finish words, key order, source keys and the standard size; `ui/variantLabel.ts`; one allow-list line.

**Game input:** `describeVariant(descriptor, vocabulary)` is the shared mechanism, with `vocabulary` required. `variantLabel(descriptor)` stays as the composed export, like the old exports in `catalogText.ts`, so no caller changes. The owner may prefer a required argument at all 40 call lines. That would touch `tradeText.ts` and `loanText.ts`, so it would have to wait for #478. This assessment recommends the kept export.

**Depends on:** nothing. Check `scan.html`'s graph, because the scanner imports `variantLabel`.

### 3. Catalog kinds, search example and side series

**Files:** new `games/pokemon/catalogFacets.ts`; `catalog/catalogText.ts`, where `KINDS` and `SEARCH_EXAMPLE` stay as composed exports; `catalog/setEras.ts`, whose `groupSetsByEra` takes the side series as a required argument, with its `CatalogFilters` caller passing it; one or two allow-list lines.

**Game input:** the kinds in order, the search example, and the side series ids.

**Depends on:** nothing. `decks/DeckLibrary.tsx` keeps its import.

### 4. Export names and panels

**Files:** `decks/ExportDialog.tsx`, `DeckLiveExport.tsx`, `PublishedLiveExport.tsx`, and optionally the Mass Entry panels; `public/PublishedExportDialog.tsx`; allow-list lines for the two dialogs.

**Game input:** a list of export kinds with their labels and panels, composed where the dialogs open. `ExportOutput.tsx` stays shared. `EXPORT_CONTENT` moves to a shared file first, so the public dialog stops importing from `decks/`.

**Depends on:** nothing in other work. Its value is lowest of the four, since there is only one game's exports to compose today. A bundle check is required, because this slice changes a public page's graph.

### Later: Edition lines and the `"Normal"` check

A single helper for the exact `set_name · number · variant` duplicates in `decks/` is worthwhile on its own, and a small one. Replacing the five `"Normal"` comparisons needs an `isDefaultVariant` input from slice 2, and one of the five is in `trades/tradeText.ts`. So do that part after slice 2 and after #478 lands. Characterize the wording first, including both Deck Import cases: new lines (`importModel.ts:181`) and owned copies (`:194`). Other line shapes stay separate.

### Not proposed

- **Deck Import words.** They can follow slice 1 when wanted. No current need requires it, and the API's line sections are Pokémon-shaped too.
- **Owner and report vocabulary.** The Card Reports assessment owns that review, so this document doesn't scope it.
- **`BULK_FINISHES`.** It should move with slice 2 only if Collection Import is in that ticket, because `web/src/collectionImport` has no test folder in `vitest.config.ts`.

## Characterization coverage

Write each slice's tests against the current code first. They must pass unchanged after the move, as with #453. Don't edit an existing assertion to fit a slice.

| Slice    | Existing coverage                                                                                                                                                  | Missing, to add first                                                                                                                                                                                                                                  |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1        | `web/tests/workspace-filters.spec.ts:246,344,409,472`, `workspace-accessibility.spec.ts`. `galleryModel.test.ts` covers listings and tiles only.                    | `galleryPrefs.test.ts`: key, defaults, malformed and unknown values, kept unknown fields. `queryToParams` for each Category value, with exact key order. Option order and words. `cardKindLine` lines. None of these has a unit test today.             |
| 2        | `web/tests/variant-label.spec.ts` (one test), `workspace-variant.spec.ts`, and `variantLabel` used in `scanner/ui/choice/controller.test.ts`.                       | `ui/variantLabel.test.ts`: unspecified, reviewed label, empty, each finish, key order, unknown key, source keys left out, standard size. `variantLabel` has no direct unit test.                                                                        |
| 3        | `catalog/setEras.test.ts:44` covers side series order. `web/tests/catalog-gallery.spec.ts:104,248`, `catalog-search.spec.ts`.                                       | `KINDS` words and order and `SEARCH_EXAMPLE` in `catalog/formatVocabulary.test.ts`, or a sibling file.                                                                                                                                                  |
| 4        | `web/tests/live-export.spec.ts`, `published-live-export.spec.ts`, `published-mass-entry.spec.ts`, `tests/tooling/test_bundle_boundary.py`.                          | The dialog's option words and order, and the section's accessible name, if the browser specs don't already pin them.                                                                                                                                    |
| Shell    | `shell/keptPages.test.ts`, `web/tests/kept-pages.spec.ts`, `app-shell.spec.ts`, `check_bundle_boundary.py`.                                                         | `shell/routes.ts` has no unit test. Add `routes.test.ts` for `pageAt`, `sectionAt` and `canonicalPath` only when a routing decision needs it.                                                                                                           |

`vitest.config.ts` includes `*.test.ts` under `shell`, `catalog`, `decks`, `loans`, `scanner`, `trades`, `ui` and `workspace`. A test placed in `public`, `owner`, `social`, `collectionImport` or `discover` would not run. `web/src/scanner/ui/choice/ChoicePanel.test.tsx` doesn't match the include list either, so check whether it runs; that is outside #532.

Each slice runs the unit tests above, `npm run check`, `npm run guardrails`, `npm run check:bundle`, and the browser specs named for it, on the default CI as `docs/agents/verification.md` describes.

## Overlap and sequencing

Compared with #539 at `0a63424f` and #526 at `cd230990`.

| Work                                     | Files it touches near this map                                                                                                                                                                       | Effect                                                                                                                                                                                                |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #478 Trade and Loan redesign, PR #539    | `main.tsx`, `shell/Shell.tsx`, `shell/useRoute.ts`, `ui/CopyTile.tsx`, `trades/tradeText.ts`, `loans/loanText.ts`, `trades/ProposalLibrary.tsx`, new `threads/`, `vitest.config.ts`, `web/tests/kept-pages.spec.ts`, `web/tests/workspace-accessibility.spec.ts` | Slices 1 to 4 touch none of its source files. Only the `"Normal"` cleanup and any shell work wait for it. Slice 1 may read `workspace-accessibility.spec.ts`, but shouldn't edit it while #539 is open. |
| #526 desktop focus, draft and blocked    | `tailwind.css`, `web/tests/app-shell.spec.ts`, `web/tests/issue-495-reachability.spec.ts`                                                                                                            | No slice touches these. Any later route test should be a unit test, or wait for #526, rather than edit `app-shell.spec.ts`.                                                                            |
| Card Reports assessment                  | Owner and report screens                                                                                                                                                                             | Owner and report vocabulary waits for its result.                                                                                                                                                     |
| Counters and Deck capture (#528 batches) | Backend only                                                                                                                                                                                         | None.                                                                                                                                                                                                 |

So the order is slice 1, then 2 and 3 in either order, then 4, with no slice waiting on #478 or #526. Only the `"Normal"` cleanup and shell work are sequenced after them. Run the slices one at a time so that `web_boundary_allowlist.txt` gets one change at a time.

## Decisions, not assumptions

These need the owner. No slice above presumes an answer.

1. **Second-game routing.** The design brief lists game-first routing, a game switcher and per-game lazy bundles as deferred. `shell/routes.ts`, `DESKTOP_TABS` and `SHELL_PAGES` would change with this, and Loans, Trades and Friends may or may not be per game.
2. **Client base paths.** ADR 0023 fixes today's `/api` paths. The 23 clients come from `scripts/client_generator.py`, so a change belongs in the generator and depends on the gateway routing that isn't built.
3. **Identity.** ADR 0023 leaves this open, and split-map section 5 recommends Design B when the work resumes. `main.tsx`'s session read, the `/auth/*` calls and anything shared across games follow from it.
4. **Preferences across games.** The storage key has a user and no game. Whether a second game shares or separates preferences is a product question for when one exists. Slice 1 must not add a game to the key.
5. **The scanner's home.** The API keeps it under `games/pokemon/scanner/`. Moving `web/src/scanner` alone would change paths in a separate entry, its bundle rules and the parity fixtures, and would add no seam. Decide this when recognition for another game is real.
6. **Generated Pokémon types.** Shared files import `CardCategory`, `ElementalType` and `TrainerType` from generated clients. Slice 1 reduces that but can't remove `CollectionHoldingQuery`, because the API's query is Pokémon-shaped. Changing it would be an API contract change.
