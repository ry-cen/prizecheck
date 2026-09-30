# 03 — Collector catalog search

**Label:** ready-for-agent

**Blocked by:** 02 — First English catalog pull

**Status:** ready-for-agent

**What to build:** A signed-in collector can search the promoted English catalog, distinguish a Card Printing from its Card Editions, inspect available art, and select an exact Edition.

- [ ] Search by nonempty English name prefix or set and collector number, with indexed case-insensitive lookup, at most 30 Printings per page, and opaque keyset cursors bound to filters and catalog revision.
- [ ] Results and details show set, number, Card Identity, available Editions and Variant Descriptors, Unspecified Variant, provenance, and last successful TCGdex pull time. No collector read calls TCGdex live.
- [ ] Show source low-resolution images in results and high-resolution images in details when available, with accessible placeholders for missing or failed images; explain that a Printing image does not prove an Edition finish.
- [ ] Catalog revision changes cause a clear page-one refresh. Escape wildcard input, bind query parameters, and preserve stable ordering on broad prefixes and Unicode names.
- [ ] Browser and real-PostgreSQL tests cover source images, absent images, broad prefixes, set/number ambiguity, cursor invalidation, source attribution, and empty/unavailable states.
