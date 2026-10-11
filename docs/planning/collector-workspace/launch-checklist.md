# Collector workspace launch checklist

**Status:** pending. Automated evidence comes from `npm run verify`; nothing here is recorded as done.

The workspace's Add cards dialog and its Reviewed Edition corrections notice are new in [#114](https://github.com/ry-cen/prizecheck/issues/114). The old Locations view is retired; `/collection` and the Decks page's Holdings panel stay.

## Implementation evidence

- [ ] Run the full gate (`npm run verify`) on the integration commit and quote the Playwright, pytest and vitest counts from its `verification.log`.
- [ ] Re-run the 25,000-Edition Move fixture and local-capacity validation with a selection spanning several source Storage Leaves, inside the two-minute budget (spec "Load proof").
- [ ] Remove a 25,000-Holding selection in one Inventory Removal from the workspace; record how long the confirmation takes to render and the staging progress.
- [ ] axe is the automated text-contrast and accessibility check. Confirm `web/tests/workspace-accessibility.spec.ts` passes in the gate. axe does not check non-text contrast (WCAG 1.4.11); that spec's token test covers control outlines and indicators.

## Release notes

- [ ] Run a catalog pull after deploying migration 027 (`migrations/027_card_attributes.sql`). Its backfill only covers Printings with a stored source record, so Printings not imported since 021 show no category or type until the next pull.
- [ ] Don't run `scripts/recovery.py backup` while a release applies migrations (see [the release runbook](../../operations/release.md)).
- [ ] Owner to confirm: the `set-desc` sort reverses the set order fully, so collector numbers without leading digits come first.
- [ ] Decks links open with the remembered gallery filters applied.
- [ ] A gallery cursor issued before the deploy returns `INVALID_CURSOR` once, and Retry recovers (#104).
- [ ] Release-overlap residual (accepted in [#106](https://github.com/ry-cen/prizecheck/issues/106)): migration 026 mirrors staged Move items one way only. During activation overlap or after a rollback, a Move or Inventory Removal staged by the new code and committed by an old process fails with nothing changed (`LOCATION_NOT_FOUND` for a workspace selection, `EMPTY_MOVE_SELECTION` for the Decks page panel); selecting again and retrying works. See [the release runbook](../../operations/release.md).
- [ ] `/workspace` is now the default page, the sign-in landing and the sign-out redirect. `/` and `/locations` redirect to it (#114).
- [ ] Four Prize gold tokens are slightly lighter for contrast: subtle text, control outline, drop outline and danger border (#114).

## Manual checks that automation does not cover

- [ ] Real touch on a phone (iOS Safari and Android Chrome): tile taps and Select mode, scrolling the gallery, the left and right drawers, the Manage locations ☰ handle drag and tap, and the Actions strip and toast above the home indicator. The browser tests only emulate touch.
- [ ] Tile drag onto sidebar rows and handle drag in Manage locations in Safari and Firefox (the browser tests run in Chromium only).
- [ ] Screen reader walkthrough with VoiceOver (macOS and iOS Safari) and NVDA (Windows): tile labels (name, set, number, copy, path), the selection count, the Move and Removal dialogs, the success and Undo toast, the stale banner and its note, Add cards and Reviewed Edition correction messages, and focus returning to the opener when a drawer or dialog closes.
- [ ] Keyboard-only traversal in Safari and Firefox, including both skip links.
- [ ] 200% browser zoom and 320 px wide reflow.
- [ ] Forced colours (Windows High Contrast): focus rings, selected tiles' check badge and the stale banner stay visible.
- [ ] The desktop header at 761 px wide with Owner controls shown: Main views fits without overlapping.
- [ ] Owner walkthrough on desktop and phone: Add cards, search, filters and sort, selection across Locations, Move by drag and by Actions, Inventory Removal, Undo, Location creation and Manage locations, prices, the Deck heading's cost and exports, and a reviewed Edition reassignment.
- [ ] Retired Locations view: a `/locations` bookmark lands on `/workspace`, `/collection` still opens, and the Decks page's Holdings panel still does Add and Move.

## Sources

The [collector workspace spec](spec.md), resolutions [27](../tcg-collection-tracker/wayfinder/resolutions/27-decide-drag-and-location-ordering.md), [28](../tcg-collection-tracker/wayfinder/resolutions/28-decide-responsive-visual-system.md) and [29](../tcg-collection-tracker/wayfinder/resolutions/29-decide-collector-workspace-selection-and-presentation.md), and [ADR 0005](../../adr/0005-collector-workspace-multi-source-direction.md).
