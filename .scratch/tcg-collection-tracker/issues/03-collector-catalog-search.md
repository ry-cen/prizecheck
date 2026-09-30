# 03 — Collector catalog search

**Label:** ready-for-agent

**Blocked by:** 02 — First English catalog pull

**Status:** complete

**What to build:** A signed-in collector can search the promoted English catalog, distinguish a Card Printing from its Card Editions, inspect available art, and select an exact Edition.

- [x] Search by nonempty English name prefix or set and collector number, with indexed case-insensitive lookup, at most 30 Printings per page, and opaque keyset cursors bound to filters and catalog revision.
- [x] Results and details show set, number, Card Identity, available Editions and Variant Descriptors, Unspecified Variant, provenance, and last successful TCGdex pull time. No collector read calls TCGdex live.
- [x] Show source low-resolution images in results and high-resolution images in details when available, with accessible placeholders for missing or failed images; explain that a Printing image does not prove an Edition finish.
- [x] Catalog revision changes cause a clear page-one refresh. Escape wildcard input, bind query parameters, and preserve stable ordering on broad prefixes and Unicode names.
- [x] Browser and real-PostgreSQL tests cover source images, absent images, broad prefixes, set/number ambiguity, cursor invalidation, source attribution, and empty/unavailable states.

## Implementation preparation (2026-09-29)

Ticket 02 is complete. Its promoted-generation and Edition contracts are available in the current checkout. Preserve the existing uncommitted implementation files.

Integration points already present: protected FastAPI routes use `verified_user` in `api/app/main.py`; the Better Auth gateway forwards signed same-origin `/api/` requests; `scripts/generate_client.py` generates `web/src/generated.ts` from FastAPI OpenAPI; the signed-in React view is in `web/src/main.tsx`; PostgreSQL migrations run in filename order.

When ticket 02 lands, implement the search against the promoted generation in PostgreSQL. Verify the final importer representation of normalized search names, set identifiers, image URLs, active Editions, descriptors, and source provenance before adding queries. Search and detail responses should carry catalog revision and last successful pull time. Keyset cursors must bind the normalized filter and revision, return at most 30 Printings, and reject a changed revision with `CATALOG_CHANGED` so the browser restarts at page one. Test literal `%` and `_` prefix input, Unicode names, stable ordering, absent/failed images, multiple Printings at one set/number filter, empty results after promotion, and unavailable results before promotion. Browser tests should use an actual promoted generation and real PostgreSQL, with no live TCGdex request on collector reads.

## Completion (2026-09-30)

Added protected catalog search and Printing detail endpoints over the active PostgreSQL generation, revision-bound signed keyset cursors, search indexes, a collector Catalog view with image fallbacks and exact Edition selection, and generated TypeScript client contracts. The browser refreshes page one when a catalog revision invalidates its cursor. Verified with the provider-neutral `scripts/ci.sh` gate on a fresh UTF-8 PostgreSQL database: 12 API tests, 5 auth tests, and 5 Chromium journeys passed.
