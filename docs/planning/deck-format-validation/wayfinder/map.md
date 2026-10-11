# Deck format validation — decision map

**Label:** wayfinder:map

**Status:** charted 2026-10-10; research tickets running

## Destination

An agreed plan for a backend endpoint that checks a deck against the Pokémon TCG Standard, Expanded and Gym Leader Challenge (GLC) formats and returns an advisory per-format result. This effort resolves decisions only. The owner will invoke `/to-spec` and `/to-ticket` afterward; the feature spec, implementation tickets and application code are outside this map.

## Notes

- Owner request on 2026-10-10: validate decks for Standard, Expanded and GLC. All three formats are in scope; research decides whether GLC needs a later phase.
- Results are advisory. Each format yields legal, not legal with per-card reasons, or unknown with reasons. Missing or unreliable catalog data produces unknown, never legal. Nothing is blocked by a result, matching the existing rule that an invalid Deck may still be published.
- The owner wants deck building to allow cards the collector doesn't own, clearly marked as unowned, likely as two objects. That decision has its own ticket; the format validator takes (Card Printing, quantity) pairs so it does not depend on the answer.
- Backend only. The owner plans a UI overhaul after the prices feature lands on `dev`; web changes, including replacing the "not evaluated" disclaimer, belong to that work.
- This effort reverses a recorded exclusion: the [MVP spec](../../tcg-collection-tracker/spec.md) lists full format legality as out of scope, user story 72 promises the disclaimer, and `api/app/construction_checks.py` hard-codes it. The owner approved recording the reversal in an ADR, written when the result contract is decided.
- Branch: `feature/deck-format-validation`, stacked on `feature/card-prices-and-deck-exports` (agent's call, delegated by the owner). Legality needs the TCGdex source metadata (`regulationMark`, the stored source record) and migrations 021–023 that exist only on the prices branch; a fresh branch from `dev` would collide on migration numbers and `api/app/decks.py`. Rebase onto `dev` once the prices branch lands.
- Use grilling and domain-modeling for decision tickets and research for factual investigation. Use `CONTEXT.md` vocabulary (Deck, Card Printing, Card Identity, Published Deck); record new terms there as they are resolved. Consult Laya before delegation. Commit and push only with owner approval; stage explicit paths.
- Tickets are GitHub Issues labelled `wayfinder` and `feature: format validation`, blocked with GitHub's native dependencies and a "Blocked by" body line. Research findings live in `research/` beside this map.

## Decisions so far

<!-- One line per closed ticket: link plus a one-line gist. -->

## Not yet specified

- Whether GLC needs its own later phase, depending on what research finds about its data needs.
- Whether ban-list or rotation changes need re-evaluation or notification for existing Decks and Published Decks.
- How Published Decks change if decks split into owned and unowned objects.

## Out of scope

- Web UI changes; the owner's planned UI overhaul covers presentation.
- Pasted or imported decklists from outside the app, unless the unowned-cards decision brings them in.
- Formats other than Standard, Expanded and GLC.
- Any guarantee of tournament legality; results stay advisory.
