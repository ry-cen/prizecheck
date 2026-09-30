# 09 — Collection totals and distribution

**Label:** ready-for-agent

**Blocked by:** 04 — Add Holdings

**Status:** ready-for-agent

**What to build:** A collector can browse an aggregate Collection, see each owned Card Edition once with its total, and find the Storage Leaves holding its copies.

- [ ] Collection derives totals from current indexed Holdings, with no separately maintained summary table. Edition detail shows direct leaf distribution; Organizational Location rollups sum descendants.
- [ ] Provide indexed search, filter, sort, and keyset pages for Collection and leaf views, with 30 Collection entries and 48 leaf Holdings per page by default.
- [ ] Cursors bind owner, filters, sort, inventory revision, and catalog revision where relevant. A change prompts a clear restart from page one rather than mixing revisions.
- [ ] Browser/API/PostgreSQL tests cover duplicate Editions across leaves, accurate totals after Add, rollups, 25,000-Holding plans, cursor invalidation, and cross-owner isolation.
