# 05 — Location tree

**Label:** ready-for-agent

**Blocked by:** 01 — Owner sign-in and Unsorted

**Status:** ready-for-agent

**What to build:** A collector can create, browse, rename, and reparent empty ordinary Locations, with a usable tree on desktop and mobile.

- [ ] The Locations view shows a desktop tree and selected leaf contents; mobile uses breadcrumbs and a Locations drawer with the same visible actions.
- [ ] Create named top-level and nested ordinary Locations. Nodes with children are Organizational Locations and cannot hold Holdings; childless ordinary nodes are Storage Leaves. A Deck cannot be a parent.
- [ ] Rename and reparent empty nodes while preserving descendants and displayed versions. Reject duplicate sibling names after trim/case folding, cycles, cross-owner references, and paths deeper than 12 nodes.
- [ ] Commands use owner-derived identity, idempotency keys, and displayed Location versions. Stale two-tab edits return a recoverable conflict without partial tree changes.
- [ ] Browser/API/PostgreSQL tests cover desktop/mobile navigation, sibling-name rules, reparenting, cycle/depth rejection, stale edits, and cross-owner not-found behavior.
