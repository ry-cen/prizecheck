# 10 — Physical Decks and checks

**Label:** ready-for-agent

**Blocked by:** 03 — Collector catalog search; 05 — Location tree; 07 — Select and Move Holdings

**Status:** ready-for-agent

**What to build:** A collector can create a physical Deck, Move copies into and out of it, and see supported construction checks based on the Deck's actual Holdings.

- [ ] A Deck is a specialized Storage Leaf with no children. Decks have a separate index and can participate as source or destination in the existing Move flow.
- [ ] Show exact total and 59/60/61-card shortage/excess results. Check the four-copy limit by English Card Identity across Printings and Editions.
- [ ] Exempt Basic Energy only when the catalog classification or a reviewed override supports it; otherwise show unresolved rather than claiming an exemption.
- [ ] State clearly that Standard eligibility, rotation, bans, and special card rules are not evaluated. An invalid or incomplete Deck remains usable and can later be published with issues visible.
- [ ] Browser/API/PostgreSQL tests cover moves in and out, four-copy cross-printing grouping, uncertain Basic Energy, Deck child rejection, and cross-owner access.
