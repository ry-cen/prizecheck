# 02 — First English catalog pull

**Label:** ready-for-agent

**Blocked by:** 01 — Owner sign-in and Unsorted

**Status:** complete

**What to build:** The owner can start the first complete English TCGdex import from a private control panel, leave the browser, and return to a durable result. Collectors see a clear unavailable state until a complete generation is promoted.

- [x] The owner starts one manual run; a second start returns the active run. A replaceable background runner persists run ID, phase, counts, result, last success, and safe errors without a schedule or browser dependency.
- [x] Enumerate English source IDs, fetch bounded full records, enumerate again, validate completeness and unique references, and atomically promote one normalized generation; any failure leaves the prior active generation intact.
- [x] Create immutable application Card Printing and Card Edition identities, conservative English Card Identity grouping, extensible Variant Descriptors, Unspecified Variant where evidence is absent, source provenance, and supported Basic Energy classification.
- [x] Preserve current and previous compressed raw generations privately, with bounded cleanup, and record a catalog revision and last-success timestamp. The owner panel reveals no credentials or raw card payloads.
- [x] API/job/PostgreSQL tests prove idempotent dispatch, interrupted fetch, mismatched enumeration, failed promotion rollback, first-import unavailable state, and no scheduled catalog trigger.

## Comments

- 2026-09-29: Implemented owner-only manual dispatch and panel, a replaceable PostgreSQL-backed worker, bounded two-pass TCGdex import, immutable normalized identities, conservative variant and Basic Energy classification, atomic generation promotion, review queue, and private compressed raw retention. Targeted PostgreSQL catalog tests (4) and TypeScript/Vite build pass. The complete local gate passed earlier with 5 API, 5 auth, and 3 browser tests, including an owner-panel browser journey. A later complete-gate run encountered an unrelated in-progress Location-tree reparent test failure in concurrent ticket 05 work; ticket 02's targeted suite and build still pass. Live full-source import remains an owner action after deployment and is part of the separate owner-only launch gate.
- 2026-09-29: At the owner's request, ran a full live English pull into a persistent local PostgreSQL database. The successful run promoted revision 1 with 23,736 Printings and 36,678 Editions; the second enumeration agreed with the first. The compressed raw generation contains 23,736 distinct source IDs and passed its SHA-256 integrity check. Six variant ambiguities remain in the owner review queue. The first attempt failed safely on a transient TCGdex 503 after 1,650 records; bounded retry/backoff was added and the subsequent complete run succeeded. This local pull is not the later production launch-gate pull.
