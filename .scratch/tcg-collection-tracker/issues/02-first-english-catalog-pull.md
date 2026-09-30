# 02 — First English catalog pull

**Label:** ready-for-agent

**Blocked by:** 01 — Owner sign-in and Unsorted

**Status:** ready-for-agent

**What to build:** The owner can start the first complete English TCGdex import from a private control panel, leave the browser, and return to a durable result. Collectors see a clear unavailable state until a complete generation is promoted.

- [ ] The owner starts one manual run; a second start returns the active run. A replaceable background runner persists run ID, phase, counts, result, last success, and safe errors without a schedule or browser dependency.
- [ ] Enumerate English source IDs, fetch bounded full records, enumerate again, validate completeness and unique references, and atomically promote one normalized generation; any failure leaves the prior active generation intact.
- [ ] Create immutable application Card Printing and Card Edition identities, conservative English Card Identity grouping, extensible Variant Descriptors, Unspecified Variant where evidence is absent, source provenance, and supported Basic Energy classification.
- [ ] Preserve current and previous compressed raw generations privately, with bounded cleanup, and record a catalog revision and last-success timestamp. The owner panel reveals no credentials or raw card payloads.
- [ ] API/job/PostgreSQL tests prove idempotent dispatch, interrupted fetch, mismatched enumeration, failed promotion rollback, first-import unavailable state, and no scheduled catalog trigger.
