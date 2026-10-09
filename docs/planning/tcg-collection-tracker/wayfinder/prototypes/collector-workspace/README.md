# Collector workspace prototype

Supports [Prototype collector workspace](../../tickets/26-prototype-collector-workspace.md). This is throwaway design evidence awaiting owner feedback, not an accepted redesign or production implementation.

## Question

Which balance of card browsing, a visible destination, and card inspection makes physical-card movement feel natural on desktop and mobile?

## Run

From the repository root:

```sh
npm run dev:web -- --port 5184 --strictPort
```

Open [the prototype](http://127.0.0.1:5184/locations?prototype=collector&variant=A). No backend or sign-in is needed for this explicit development-only sample preview. The ordinary application retains its existing sign-in flow.

- **A — Gallery workspace:** sidebar, card-art grid, and inspection panel.
- **B — Deck building table:** owned-card pool beside the selected destination's contents.
- **C — Inventory & inspection:** compact inventory rows with prominent card inspection.

Use the floating arrows to switch variants; the URL retains the chosen variant. All variations share in-memory sample Holdings. Reload or Reset sample restores sample data. Card art loads from TCGdex, with a local visual fallback.

## Try it

1. Search the owned cards or filter by type, then select a Card Edition.
2. Inspect its physical source, choose a quantity, and choose a destination.
3. Drag onto a destination, or use the Move button. Browse that Deck to move copies back to storage.
4. Use Undo to restore the previous placement.
5. Try a narrow viewport and use the Locations and inspection drawers.

## Boundaries

Sample data only; no real inventory writes or persistence. A Collection is an aggregate, and every Move has a specific source Storage Leaf. Sample Decks are intentionally incomplete. The prototype explores one Card Edition and quantity at a time; bulk selection, fan-out, Location ordering, and complete accessibility are not established by this artifact. The current inventory contract remains authoritative.

The prototype ticket stays in progress until the owner reacts to the layouts. The separate drag/ordering and responsive-system tickets remain unresolved. No commit, push, production promotion, or accepted specification is implied.

## Verification

Pending primary browser inspection and build checks. The full regression gate was attempted but its preflight requires an unconfigured `TEST_ADMIN_DATABASE_URL`; this is not a passing regression run.
