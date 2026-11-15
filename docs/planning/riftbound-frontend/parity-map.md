# Collection and Locations parity

Frozen visual reference: Pokémon M7 `ed1231d521dc1210e2ab4ca558e5b2fb9952b1d1`; saved PNGs only, no M7 code imported or copied. Base sources below are relative to `web/src/`. Screenshots `B/<file>` mean `/home/ryan/.t3/worktrees/prizecheck/coord-ui-hillclimb-m4-v-a8e8ff0ae319d51a/.claude/worktrees/score-m7-b/.scratch/hc-review/m7-b/<file>`. `A/<file>` means the corresponding `score-m7-a/.scratch/hc-review/m7-a/shots/<file>`.

| Surface | Pokémon source (base path) and M7 screenshot | Riftbound file (under web/src/games/riftbound/) | Status | Re-check when Pokémon changes |
| --- | --- | --- | --- | --- |
| Desktop top nav | shell/Shell.tsx; B/desktop-collection.png | RiftboundApp.tsx | mirrored-locally | Nav order, active marker, header spacing |
| Locations heading, All owned, tree read order | workspace/LocationNav.tsx, workspace/locationTree.ts; B/desktop-collection.png | CollectionView.tsx | shared-primitive | Tree ordering, disclosure and current state; folders disclose; leaves choose |
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
