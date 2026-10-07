# 10 — Physical Decks and checks

**Label:** ready-for-agent

**Blocked by:** 03 — Collector catalog search; 05 — Location tree; 07 — Select and Move Holdings

**Status:** complete

**What to build:** A collector can create a physical Deck, Move copies into and out of it, and see supported construction checks based on the Deck's actual Holdings.

- [x] A Deck is a specialized Storage Leaf with no children. Decks have a separate index and can participate as source or destination in the existing Move flow.
- [x] Show exact total and 59/60/61-card shortage/excess results. Check the four-copy limit by English Card Identity across Printings and Editions.
- [x] Exempt Basic Energy only when the catalog classification or a reviewed override supports it; otherwise show unresolved rather than claiming an exemption.
- [x] State clearly that Standard eligibility, rotation, bans, and special card rules are not evaluated. An invalid or incomplete Deck remains usable and can later be published with issues visible.
- [x] Browser/API/PostgreSQL tests cover moves in and out, four-copy cross-printing grouping, uncertain Basic Energy, Deck child rejection, and cross-owner access.

## Final integration validation — 2026-10-06

Closed on `codex/mvp-integration` after the combined gate at `859f2aa`: 68 API/PostgreSQL tests, six live authentication tests, and 19 Chromium browser tests passed, along with migrations, generated contracts, TypeScript and build. Independent Standards/Spec review findings are resolved. See [integration evidence](../evidence/integration-validation.md) and [review resolutions](../evidence/code-review.md). Production provider, capacity and launch proof remains tracked by tickets 15–18; this closure records application implementation and local validation.
