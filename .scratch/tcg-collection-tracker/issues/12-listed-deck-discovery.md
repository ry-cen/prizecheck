# 12 — Listed Deck discovery

**Label:** ready-for-agent

**Blocked by:** 11 — Unlisted Deck publishing

**Status:** complete

**What to build:** A Deck owner can opt a Published Deck into Listed discovery and anonymous visitors can find it without seeing private account or Collection information.

- [x] Unlisted remains the default. Only the Deck owner can switch visibility; Listed-to-Unlisted changes take effect on the next request without changing snapshot version.
- [x] Bounded public search matches the public title or included Card Identity, sorted by recent publication, and exposes only sanitized summary fields.
- [x] Discovery uses public projections without waking PostgreSQL for each anonymous view. Private edits do not change the public result until republish.
- [x] Browser/API/object-storage tests cover discovery entry/removal, cursor paging, noindex behavior, escaped untrusted text, and absence of owner or Location data.

## Final integration validation — 2026-10-06

Closed on `codex/mvp-integration` after the combined gate at `859f2aa`: 68 API/PostgreSQL tests, six live authentication tests, and 19 Chromium browser tests passed, along with migrations, generated contracts, TypeScript and build. Independent Standards/Spec review findings are resolved. See [integration evidence](../evidence/integration-validation.md) and [review resolutions](../evidence/code-review.md). Production provider, capacity and launch proof remains tracked by tickets 15–18; this closure records application implementation and local validation.
