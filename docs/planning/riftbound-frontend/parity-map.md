# Collection and Locations parity

Frozen visual reference: Pokémon M7 `ed1231d521dc1210e2ab4ca558e5b2fb9952b1d1`; saved PNGs only, no M7 code imported or copied. Base sources below are relative to `web/src/`. Screenshots `B/<file>` mean `/home/ryan/.t3/worktrees/prizecheck/coord-ui-hillclimb-m4-v-a8e8ff0ae319d51a/.claude/worktrees/score-m7-b/.scratch/hc-review/m7-b/<file>`. `A/<file>` means the corresponding `score-m7-a/.scratch/hc-review/m7-a/shots/<file>`.

| Surface | Pokémon source (base path) and M7 screenshot | Riftbound file (under web/src/games/riftbound/) | Status | Re-check when Pokémon changes |
| --- | --- | --- | --- | --- |
| Desktop top nav | shell/Shell.tsx; B/desktop-collection.png | RiftboundApp.tsx | mirrored-locally | Nav order, active marker, header spacing |
| Locations heading, All owned, tree read order | workspace/LocationNav.tsx, workspace/locationTree.ts; B/desktop-collection.png | CollectionView.tsx | shared-primitive | Tree ordering, disclosure and current state; folders disclose; leaves are links (`hrefFor`, #669) that choose on a plain click and open in a new tab otherwise |
| Organization-level listing | workspace/LocationNav.tsx; B/desktop-collection.png | local/collectionFixtures.ts | omitted (folders disclose only, matching Pokémon) | Revisit only if Pokémon makes organization listing reachable |
| Page heading and copies/Edition totals | workspace/Workspace.tsx; B/desktop-collection.png | CollectionView.tsx | mirrored-locally | PageHeader and lowercase pluralized totals share a baseline row; subtle tabular meta and mb-5 spacing |
| Search | workspace/GalleryControls.tsx; B/desktop-collection.png | CollectionView.tsx | shared-primitive | 420 px search cap, “Search your cards…” placeholder; fixture substring behavior remains explicit |
| Copy tiles and Location captions | ui/CopyTile.tsx, workspace/Gallery.tsx; B/desktop-detail-collection-detail.png | CollectionView.tsx | shared-primitive | Small tile token (5 desktop columns at 1280), captions, one-copy toggle and focus ring |
| Copy expansion | workspace/galleryModel.ts; B/desktop-collection.png | collection.ts | mirrored-locally | Do not import galleryModel: runtime Pokémon labels; keep ranges and true quantities separate |
| Desktop inspector | workspace/Inspector.tsx; B/desktop-detail-collection-detail.png | CollectionView.tsx | mirrored-locally | Sticky header offset and bounded scrolling; semibold title, Variant finish, divider, domain/type and exact per-Location quantities |
| Phone Locations drawer | workspace/Workspace.tsx, ui/Dialog.tsx; A/j3-phone-locations-drawer.png | CollectionView.tsx | shared-primitive | Side drawer, touch rows, focus return to opener |
| Phone details sheet | workspace/Inspector.tsx, ui/Dialog.tsx; B/phone-detail-collection-detail.png | CollectionView.tsx | shared-primitive | Sheet focus trap, Escape/close, contained art |
| Phone Collection/tab bar | workspace/Workspace.tsx, shell/Shell.tsx; B/phone-j1-collection.png | RiftboundApp.tsx, CollectionView.tsx | mirrored-locally | Token-sized grid, tabs and bottom spacing |
| Loading, empty Collection, empty Location, no matches and retry | workspace/Gallery.tsx; B/desktop-collection.png (populated reference only) | CollectionView.tsx | mirrored-locally | Preserve distinct states; no fixtures as failure fallback |
| Back/Forward and query restoration | workspace/Workspace.tsx; B/desktop-collection.png | navigation.ts, RiftboundApp.tsx | mirrored-locally | Section query retention, focus and selection clearing |
| Sort control | workspace/GalleryControls.tsx; B/desktop-collection.png | local/collectionFixtures.ts | omitted (fixed Name A–Z) | Reassess with live read contract |
| Filters | workspace/GalleryControls.tsx; B/desktop-collection.png | CollectionView.tsx | omitted (D4 facets undecided) | Approved Riftbound facets only |
| Card-size control | workspace/GalleryControls.tsx; B/desktop-collection.png | CollectionView.tsx | omitted (WP1 fixed Small tile token) | Small defaults: five columns at 1280, three at 375; reassess responsive density |
| Names control | workspace/GalleryControls.tsx; B/desktop-collection.png | CollectionView.tsx | omitted (WP1 art plus Location captions) | Accessible tile name and inspector facts |
| Prices control/data | workspace/GalleryControls.tsx, EditionPrice.tsx; B/desktop-collection.png | CollectionView.tsx | omitted (no supported price API) | No provenance or price imports |
| Multi-select, SelectionBar and Actions | workspace/SelectionBar.tsx; B/desktop-detail-collection-detail.png | CollectionView.tsx | deferred (WP2) | Single selection is deliberately local in WP1 |
| Add, Move, Remove, Undo | workspace/useInventoryActions.ts; B/desktop-detail-collection-detail.png | CollectionView.tsx | deferred (WP2) | Approved write/replay/revision contracts first |
| Create, rename, move and settings for Locations | workspace/ManageLocations.tsx; A/j3-phone-locations-drawer.png | CollectionView.tsx | deferred (after WP2) | Optional LocationNav management props stay absent |
| Loans, social, decks, scanner and import | workspace/Workspace.tsx; B/desktop-collection.png | CollectionView.tsx | omitted (outside WP1) | Do not inherit game-specific behavior through shared imports |
| M7 stale action reopening detail above retry | workspace/Workspace.tsx; B/desktop-detail-collection-detail.png | CollectionView.tsx | omitted (defect not copied) | No retained action callback; retry clears selection, selection is view-keyed |
| M7 focus hidden behind fixed phone tabs | shell/Shell.tsx; B/phone-detail-collection-detail.png | RiftboundApp.tsx | mirrored-locally (defect corrected) | Document scroll-padding-bottom covers both Catalog and Collection; test actual focus bounds |

## Propagating a Pokémon UI change

1. Identify its neutral primitive and the affected rows above; inspect the new visual reference at matching viewports.
2. Propagate shared primitive changes through explicit props. Mirror composition changes only under Riftbound; do not import Pokémon rules, galleryModel or the application shell.
3. Re-check unsupported controls, game-owned labels, exact Edition/Location identity and no preference writes.
4. Run focused unit/browser tests, compare desktop inspector and phone Collection/drawer attachments, and verify keyboard focus clears tabs in both sections.
5. Run the required boundary/build checks and update this map with intentional capability differences.

## WP2 write surfaces

| Surface | Reference under web/src | Riftbound composition | Capability / defect handling |
| --- | --- | --- | --- |
| Single-copy selection bar | workspace/SelectionBar.tsx | CollectionView.tsx | Locally mirrors the centred floating M7 pill: “1 copy selected · 1 edition · 1 location”, with Move…/Remove…/Clear selection inside Actions. Inspector reserves bottom space; phone pill clears tabs. No Pokémon runtime hooks, Loans or multi-select. |
| Add dialog | catalog Add composition, ui/Stepper.tsx, ui/Dialog.tsx | CollectionWrites.tsx, RiftboundApp.tsx | Leaf path picker, Unsorted default, 1–99 Stepper, confirm Add N copies. Single Add has no Undo. |
| Move dialog | workspace/InventoryDialogs.tsx | CollectionWrites.tsx | Leaf picker excludes source, shows paths, explicit Move 1 copy confirmation. |
| Remove dialog | workspace/InventoryDialogs.tsx | CollectionWrites.tsx | “Remove 1 copy from your Collection”, explicit Remove 1 copy confirmation. |
| Undo toast | workspace/UndoToast.tsx, ui/Toast.tsx | CollectionWrites.tsx | Shared ToastProvider, Undo and Dismiss Undo actions, confirmed success only. Fixture-only core semantics; no real routes claimed. |
| M7 defect 1 avoidance | workspace stale-action/detail composition | CollectionView.tsx | Phone details sheet closes while action dialog is mounted. Stale error stays in that sole dialog; reload reads the current version without reopening inspector/detail. |
| Inspector nits and clamp | workspace/Inspector.tsx:285 | CollectionView.tsx | Muted Variant label with separate value, dashed empty card, clamp guarded against max(1,pages), no heading-focus transfer for automatic clamp. |

The earlier deferred WP2 rows above describe WP1. These rows supersede them for the supported single-copy fixture flows. Location management remains WP3; no Decks are implemented. Screenshots and actual check counts are reported with each implementation/review reply and maintained in the PR body by the planner.

## Feature map: every Pokémon page against Riftbound

Reference for this map: the frozen Pokémon M9 candidate `0d22c23cea23277a1a43d86efadc60043c8ff99c`, from the saved PNGs under the UI hill-climb's `score-m9-a/.scratch/hc-review/m9-a/shots/` and `score-m9-b/.scratch/hc-review/m9-b/`. M9 is unmerged and still being scored, so this map uses it only for layout, read order, controls and state patterns. No M9 code is imported or copied. Earlier rows keep their M7 reference. Each slice records its own reference SHA. Routes come from `web/src/shell/routes.ts` on dev `1bac5801`.

Status values:
- **covered**: matches Pokémon for the supported data.
- **partial**: some flows done; the rest are listed.
- **missing**: not started.
- **intentional difference**: a game-specific capability difference, not unfinished work.

Contract column:
- **verified**: grounded in game-neutral core code, with citations in the slice docs.
- **fixture-only**: a provisional fixture contract with no Riftbound route.
- **gated**: needs an owner, backend or rules decision first.

| Pokémon page or feature (route) | Riftbound status | Contract | Gate or note |
| --- | --- | --- | --- |
| Catalog browse, search, filters, card detail (`/catalog`) | partial: #670 | fixture-only | Facet shape D4 is undecided. Pokémon smart search and infinite loading are intentional differences for the fixture. The real read API is #661, gated on #534. |
| Catalog Add mode and add queue | partial: single Add from card detail (#672 WP2) | verified semantics, fixture store | Batch add and the add queue are not built (batch Add writes an Undo in core). |
| Collection gallery, inspector, Locations tree (`/collection`) | partial: #672 WP1 | verified semantics, fixture store | Missing: filters and sort (D4), card size, Names and Prices toggles (no price API), multi-select and marquee. |
| Move, Remove, Undo | partial: one copy (#672 WP2) | verified semantics, fixture store | Multi-copy and multi-source moves are not built. Commit without Undo and Put away (Deck) are left out. |
| Location create, rename, move, delete (Collection sidebar `+` and gear) | missing → **WP3 (this slice)** | verified (`api/app/location_tree.py`), fixture store | Unsorted gets no management controls: the recorded CONTEXT/code conflict needs an owner decision. The `create_unsorted_child` conversion is left out for the same reason. |
| Hidden Locations and For trade (Location settings) | missing | gated | Friends and Trading capabilities; no Riftbound social backend. |
| Borrowed and Lent entries | missing | gated | Loans backend and social graph. |
| Decks list, Deck editor, Library (`/decks`, `/decks/<id>`) | missing | gated / candidate fixture slice | #663. The deck shape and the section and count rules are unverified. A fixture slice needs grounding of the generic Deck List operations first (isolated check in progress). Formats, legality, readiness, prices, publishing, Gather and Buy missing are never invented. |
| Want List, Pick List, Trade wants (`/decks/want-list`) | missing | gated | #663 requires actual backend semantics. |
| Published Decks and Discover (public routes) | missing | gated | Publishing is excluded by #663. |
| Deck import and export, Pokémon TCG Live export | missing | intentional difference / gated | Excluded by #662 and #663. |
| Collection import, Scan cards (scanner) | missing | intentional difference / gated | Excluded by #662. The scanner models are Pokémon-specific. |
| Loans (`/loans`) and Trades (`/trades`) | missing | gated | Social backend, identity (#531) and #534. |
| Card reports (`/reports`) | missing | gated | Metadata reports need a Riftbound catalog review backend (#534). |
| Settings, account and sign-ins (`/settings`) | missing | gated | Auth and identity decisions (#531). Fixtures make no claim of real account isolation. |
| Owner controls (`/owner`) | missing | gated | Owner catalog review is under #534. |
| Notifications, Inbox, Friends drawer | missing | gated | Social backend. |
| Prices (tiles, inspector, deck costs) | missing | gated | No supported Riftbound price API. Price text is never shown by assumption. |

### Shared reuse candidates (not done; each needs a narrow, reviewed shared change)

- `workspace/CreateLocationDialog.tsx` calls `createLocation` from `location_generated` directly. If it took an injected `create` function, both games could share the dialog. Left alone for now because the UI hill-climb is actively changing `workspace/*`.
- `workspace/SelectionBar.tsx`, `InventoryDialogs.tsx` and `UndoToast.tsx` carry Pokémon runtime hooks (galleryModel, useInventoryActions). Riftbound mirrors them locally. Splitting them into presentation-only parts would make one shared component possible.
- `workspace/LocationNav.tsx` and `locationTree.ts` are already shared through explicit props.

### How to propagate a Pokémon UI change

1. Find the surface's row in the tables above.
2. If its status is shared-primitive, check that the Riftbound browser specs still pass.
3. If its status is mirrored-locally, apply the same layout, read-order, control or state change to the named Riftbound file and update the screenshot comparison.
4. If its status is omitted or gated, change nothing unless the gate's decision or contract has landed.
