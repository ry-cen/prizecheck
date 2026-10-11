# Deck format validation — decision map

**Label:** wayfinder:map

**Status:** charted 2026-10-10; research tickets running

## Destination

An agreed plan for Deck Lists, the intended cards of a Deck including cards the collector doesn't own, and a backend endpoint that checks a Deck List against the Pokémon TCG Standard, Expanded and Gym Leader Challenge (GLC) formats with an advisory per-format result. The destination was widened from format validation alone on 2026-10-10, when the owner chose to put Deck Lists in the same spec. This effort resolves decisions only. The owner will invoke `/to-spec` and `/to-ticket` afterward; the feature spec, implementation tickets and application code are outside this map.

## Notes

- Owner request on 2026-10-10: validate decks for Standard, Expanded and GLC. All three formats are in scope; research decides whether GLC needs a later phase.
- Results are advisory. Each format yields legal, not legal with per-card reasons, or unknown with reasons. Missing or unreliable catalog data produces unknown, never legal. Nothing is blocked by a result, matching the existing rule that an invalid Deck may still be published.
- Deck building allows cards the collector doesn't own through the Deck's Deck List (see Decisions so far). Format checks run on Deck List lines.
- Backend only. The owner plans a UI overhaul after the prices feature lands on `dev`; web changes, including replacing the "not evaluated" disclaimer, belong to that work.
- This effort reverses a recorded exclusion: the [MVP spec](../../tcg-collection-tracker/spec.md) lists full format legality as out of scope, user story 72 promises the disclaimer, and `api/app/construction_checks.py` hard-codes it. The owner approved recording the reversal in an ADR, written when the result contract is decided.
- Branch: `feature/deck-format-validation`, stacked on `feature/card-prices-and-deck-exports` (agent's call, delegated by the owner). Legality needs the TCGdex source metadata (`regulationMark`, the stored source record) and migrations 021–023 that exist only on the prices branch; a fresh branch from `dev` would collide on migration numbers and `api/app/decks.py`. Rebase onto `dev` once the prices branch lands.
- Use grilling and domain-modeling for decision tickets and research for factual investigation. Use `CONTEXT.md` vocabulary (Deck, Card Printing, Card Identity, Published Deck); record new terms there as they are resolved. Consult Laya before delegation. Commit and push only with owner approval; stage explicit paths.
- Tickets are GitHub Issues labelled `wayfinder` and `feature: format validation`, blocked with GitHub's native dependencies and a "Blocked by" body line. Research findings live in `research/` beside this map.

## Decisions so far

<!-- One line per closed ticket: link plus a one-line gist. -->

- [Research TCGdex legality data and catalog coverage](https://github.com/ry-cen/tcg-tracker/issues/71): TCGdex `legal.*` is a mark-and-series rule, current with the G rotation, but it ignores reprint equivalence, McDonald's and Trainer Kit pool extras, and has 9 Expanded ban errors; Rule Box and ACE SPEC have no single field, `regulationMark` covers 96% of Sword & Shield-onward printings, and manual Printings carry no metadata. [Findings](https://github.com/ry-cen/tcg-tracker/blob/feature/deck-format-validation/docs/planning/deck-format-validation/wayfinder/research/tcgdex-legality-data.md)
- [Decide how a Deck holds cards the collector doesn't own](https://github.com/ry-cen/tcg-tracker/issues/72): a Deck is one object, its Holdings plus a Deck List of intended Card Editions (owned, elsewhere or not owned). Moves keep the list covering the Holdings, a Pick List confirms retrievals as Moves, deleting a Deck spills its cards to Unsorted, and a Published Deck snapshots the Deck List and outlives the Deck. [Resolution](resolutions/decide-deck-list-model.md)
- [Research Standard and Expanded construction rules](https://github.com/ry-cen/tcg-tracker/issues/69): Standard allows regulation marks H and later (G rotated April 2026, next rotation unannounced); Expanded is Black & White onward plus marks D and later, with a 27-entry printing-specific ban list; older printings count when name and text are functionally identical to a legal printing, but whether that covers Pokémon is officially unclear. [Findings](https://github.com/ry-cen/tcg-tracker/blob/feature/deck-format-validation/docs/planning/deck-format-validation/wayfinder/research/standard-and-expanded-rules.md)
- [Research Gym Leader Challenge construction rules](https://github.com/ry-cen/tcg-tracker/issues/70): fan-made format (Andrew Mahone / Tricky Gym), Black & White-onward pool with no rotation and its own 13-card ban list (some bans name a single printing); singleton by name except Basic Energy, one Pokémon type, no Rule Box or ACE SPEC; a validator needs per-printing type, Rule Box and ACE SPEC flags. [Findings](https://github.com/ry-cen/tcg-tracker/blob/feature/deck-format-validation/docs/planning/deck-format-validation/wayfinder/research/gym-leader-challenge-rules.md)

## Not yet specified

- Whether GLC needs its own later phase, depending on what research finds about its data needs.
- Whether ban-list or rotation changes need re-evaluation or notification for existing Decks and Published Decks.

## Out of scope

- Web UI changes; the owner's planned UI overhaul covers presentation.
- Pasted or imported decklists from outside the app.
- Formats other than Standard, Expanded and GLC.
- A social network where collectors request the cards their Deck Lists don't own. This is a future effort; the Deck List design must not rule it out, and identity-level ("any printing") lines belong to it.
- Any guarantee of tournament legality; results stay advisory.
