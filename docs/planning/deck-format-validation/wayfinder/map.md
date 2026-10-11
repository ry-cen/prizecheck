# Deck format validation — decision map

**Label:** wayfinder:map

**Status:** complete planning 2026-10-10; [spec](../spec.md) written; next step is owner-invoked `/to-ticket`

## Destination

An agreed plan for Deck Lists, the intended cards of a Deck including cards the collector doesn't own, and a backend endpoint that checks a Deck List against the Pokémon TCG Standard, Expanded and Gym Leader Challenge (GLC) formats with an advisory per-format result. The destination was widened from format validation alone on 2026-10-10, when the owner chose to put Deck Lists in the same spec. This effort resolves decisions only. The owner will invoke `/to-spec` and `/to-ticket` afterward; the feature spec, implementation tickets and application code are outside this map.

## Notes

- Owner request on 2026-10-10: validate decks for Standard, Expanded and GLC. All three formats are in scope and in the first phase.
- Results are advisory. Each format yields legal, not legal with per-card reasons, or unknown with reasons. Missing or unreliable catalog data produces unknown, never legal. Nothing is blocked by a result, matching the existing rule that an invalid Deck may still be published.
- Deck building allows cards the collector doesn't own through the Deck's Deck List (see Decisions so far). Format checks run on Deck List lines.
- Backend only. The owner plans a UI overhaul after the prices feature lands on `dev`; web changes, including replacing the "not evaluated" disclaimer, belong to that work.
- This effort reverses a recorded exclusion: the [MVP spec](../../tcg-collection-tracker/spec.md) lists full format legality as out of scope, user story 72 promises the disclaimer, and `api/app/construction_checks.py` hard-codes it. The reversal is recorded in [ADR 0010](../../../adr/0010-advisory-format-legality-in-scope.md).
- Branch: `feature/deck-format-validation`. It was first stacked on `feature/card-prices-and-deck-exports`, whose catalog source metadata and migrations 021–023 legality depends on, and was rebased onto `dev` on 2026-10-10 after the prices branch landed.
- Use grilling and domain-modeling for decision tickets and research for factual investigation. Use `CONTEXT.md` vocabulary (Deck, Card Printing, Card Identity, Published Deck); record new terms there as they are resolved. Consult Laya before delegation. Commit and push only with owner approval; stage explicit paths.
- Tickets are GitHub Issues labelled `wayfinder` and `feature: format validation`, blocked with GitHub's native dependencies and a "Blocked by" body line. Research findings live in `research/` beside this map.

## Decisions so far

<!-- One line per closed ticket: link plus a one-line gist. -->

- [Decide the format check result and endpoint contract](https://github.com/ry-cen/prizecheck/issues/75): `GET /api/decks/{id}/format-checks` plus results returned with every Deck List edit; per-format legal / not_legal / unknown with coded issues; saved results keyed by list, rules, attribute revisions and date; Published Decks recompute anonymously from the public projection; `as_of` dates; ten acceptance criteria. [Resolution](resolutions/decide-format-check-contract.md) · [ADR 0010](../../../adr/0010-advisory-format-legality-in-scope.md)
- [Decide how existing Decks and Deck features move onto Deck Lists](https://github.com/ry-cen/prizecheck/issues/76): existing Decks get a Deck List from their Holdings; construction checks, cost (Deck List cost and cost to complete), exports (Mass Entry defaults to not-owned lines) and publishing read the Deck List; cutting a held card leaves surplus to put away; a publication outlives its Deck and is managed by token. [Resolution](resolutions/decide-deck-list-migration.md)
- [Decide where format rules live and who updates them](https://github.com/ry-cen/prizecheck/issues/74): Format Rules live in a dated, versioned rules file per format, updated by commit; card attributes are derived from TCGdex by rule and corrected by maintainer-reviewed records; gaps in the rules yield unknown, never not legal; GLC stays in the first phase. [Resolution](resolutions/decide-format-rules-source.md)
- [Decide which printings count as the same card for format legality](https://github.com/ry-cen/prizecheck/issues/73): copy limits count by Card Identity (subtitles stripped); legality and bans apply to a Reprint Group of functionally identical printings, built automatically from identical text plus maintainer merges and splits; only Trainers and Energy inherit legality from a legal reprint. A printing whose text differs, such as Rare Candy sm1-129 against me01-125, is a separate group and becomes legal only through a reviewed merge (ticket 14, [#95](https://github.com/ry-cen/prizecheck/issues/95)). [Resolution](resolutions/decide-reprint-groups.md)
- [Research TCGdex legality data and catalog coverage](https://github.com/ry-cen/prizecheck/issues/71): TCGdex `legal.*` is a mark-and-series rule, current with the G rotation, but it ignores reprint equivalence, McDonald's and Trainer Kit pool extras, and has 9 Expanded ban errors; Rule Box and ACE SPEC have no single field, `regulationMark` covers 96% of Sword & Shield-onward printings, and manual Printings carry no metadata. [Findings](https://github.com/ry-cen/prizecheck/blob/feature/deck-format-validation/docs/planning/deck-format-validation/wayfinder/research/tcgdex-legality-data.md)
- [Decide how a Deck holds cards the collector doesn't own](https://github.com/ry-cen/prizecheck/issues/72): a Deck is one object, its Holdings plus a Deck List of intended Card Editions (owned, elsewhere or not owned). Moves keep the list covering the Holdings, a Pick List confirms retrievals as Moves, deleting a Deck spills its cards to Unsorted, and a Published Deck snapshots the Deck List and outlives the Deck. [Resolution](resolutions/decide-deck-list-model.md) · [ADR 0009](../../../adr/0009-deck-list-is-part-of-the-deck.md)
- [Research Standard and Expanded construction rules](https://github.com/ry-cen/prizecheck/issues/69): Standard allows regulation marks H and later (G rotated April 2026, next rotation unannounced); Expanded is Black & White onward plus marks D and later, with a 27-entry printing-specific ban list; older printings count when name and text are functionally identical to a legal printing, but whether that covers Pokémon is officially unclear. [Findings](https://github.com/ry-cen/prizecheck/blob/feature/deck-format-validation/docs/planning/deck-format-validation/wayfinder/research/standard-and-expanded-rules.md)
- [Research Gym Leader Challenge construction rules](https://github.com/ry-cen/prizecheck/issues/70): fan-made format (Andrew Mahone / Tricky Gym), Black & White-onward pool with no rotation and its own 13-card ban list (some bans name a single printing); singleton by name except Basic Energy, one Pokémon type, no Rule Box or ACE SPEC; a validator needs per-printing type, Rule Box and ACE SPEC flags. [Findings](https://github.com/ry-cen/prizecheck/blob/feature/deck-format-validation/docs/planning/deck-format-validation/wayfinder/research/gym-leader-challenge-rules.md)

## Not yet specified

No known decision remains. The next step is owner-invoked `/to-spec`, then `/to-ticket`. Rule changes need no re-evaluation, because saved results are keyed by rules and date (see the result contract).

## Out of scope

- Web UI changes; the owner's planned UI overhaul covers presentation.
- Pasted or imported decklists from outside the app.
- Formats other than Standard, Expanded and GLC.
- A social network where collectors request the cards their Deck Lists don't own. This is a future effort; the Deck List design must not rule it out, and identity-level ("any printing") lines belong to it.
- Any guarantee of tournament legality; results stay advisory.
- Database-editable Format Rules with an owner API, a later effort if someone other than the owner maintains rules.
- Reporting catalog data errors upstream to TCGdex.
- Notifying collectors when a rule change alters a Deck's legality.
