# 09 — Collection totals and distribution

**Label:** ready-for-agent

**Blocked by:** 04 — Add Holdings

**Status:** complete

**What to build:** A collector can browse an aggregate Collection, see each owned Card Edition once with its total, and find the Storage Leaves holding its copies.

- [x] Collection derives totals from current indexed Holdings, with no separately maintained summary table. Edition detail shows direct leaf distribution; Organizational Location rollups sum descendants.
- [x] Provide indexed search, filter, sort, and keyset pages for Collection and leaf views, with 30 Collection entries and 48 leaf Holdings per page by default.
- [x] Cursors bind owner, filters, sort, inventory revision, and catalog revision where relevant. A change prompts a clear restart from page one rather than mixing revisions.
- [x] Browser/API/PostgreSQL tests cover duplicate Editions across leaves, accurate totals after Add, rollups, 25,000-Holding plans, cursor invalidation, and cross-owner isolation.

## Implementation evidence

Implemented derived totals, direct Storage Leaf distribution, descendant rollups, filters/name-or-quantity sorting, and revision-bound keyset pages (30 Collection / 48 leaf). Signed API tests and Add regressions pass on disposable PostgreSQL; TypeScript/build and generated-client checks pass. The 25,000-Holding fixture records indexed distribution and leaf quantity plans in [query-plan evidence](../validation/09-collection-25000-plans.json). Browser test is prepared; ticket remains open until the integration browser gate confirms the Collection navigation.

## Final integration validation — 2026-10-06

Closed on `codex/mvp-integration` after the combined gate at `859f2aa`: 68 API/PostgreSQL tests, six live authentication tests, and 19 Chromium browser tests passed, along with migrations, generated contracts, TypeScript and build. Independent Standards/Spec review findings are resolved. See [integration evidence](../evidence/integration-validation.md) and [review resolutions](../evidence/code-review.md). Production provider, capacity and launch proof remains tracked by tickets 15–18; this closure records application implementation and local validation.
