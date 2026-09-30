# 05 — Location tree

**Label:** ready-for-agent

**Blocked by:** 01 — Owner sign-in and Unsorted

**Status:** complete

**What to build:** A collector can create, browse, rename, and reparent empty ordinary Locations, with a usable tree on desktop and mobile.

- [x] The Locations view shows a desktop tree and selected leaf contents; mobile uses breadcrumbs and a Locations drawer with the same visible actions.
- [x] Create named top-level and nested ordinary Locations. Nodes with children are Organizational Locations and cannot hold Holdings; childless ordinary nodes are Storage Leaves. A Deck cannot be a parent.
- [x] Rename and reparent empty nodes while preserving descendants and displayed versions. Reject duplicate sibling names after trim/case folding, cycles, cross-owner references, and paths deeper than 12 nodes.
- [x] Commands use owner-derived identity, idempotency keys, and displayed Location versions. Stale two-tab edits return a recoverable conflict without partial tree changes.
- [x] Browser/API/PostgreSQL tests cover desktop/mobile navigation, sibling-name rules, reparenting, cycle/depth rejection, stale edits, and cross-owner not-found behavior.

## Implementation notes

The selected leaf shows its empty state until ticket 04 adds Holdings and card stacks. Stocked-leaf conversion and deletion remain in ticket 06. Verified with `scripts/ci.sh` against a disposable PostgreSQL database: 8 API tests, 5 auth tests, and 4 Chromium journeys passed.
