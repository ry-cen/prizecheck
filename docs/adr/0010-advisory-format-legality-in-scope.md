# Advisory format legality is in scope

**Status:** accepted; planning decision, not yet implemented. Supersedes the MVP exclusion of format legality. Superseded in part by [ADR 0011](0011-publishing-needs-a-legal-target-format.md): publishing now needs a legal result in the Deck's Target Format, and a Deck is checked against its Target Format only.

The [MVP spec](../planning/tcg-collection-tracker/spec.md) excluded full Standard and other format legality, user story 72 promised a disclaimer that it isn't evaluated, and the construction checks hard-code that disclaimer. The owner reversed this on 2026-10-10.

Deck Lists are now checked against Standard, Expanded and Gym Leader Challenge. Each result is advisory: `legal`, `not_legal`, or `unknown`, with reasons. A result never blocks editing, moving or publishing, and it is not a guarantee of tournament legality.

Missing or unreliable data yields `unknown`, never `legal`. That covers an unrecorded set date, an unseen regulation mark, or an unreviewed attribute.

## Considered options

- **Trust TCGdex `legal` flags.** Rejected: they ignore reprint equivalence and McDonald's and Trainer Kit cards, and contain Expanded ban errors.

Format Rules live in a dated, versioned rules file per format, updated by commit. Card attributes are derived from TCGdex and corrected by maintainer review.

See the [result and endpoint contract](../planning/deck-format-validation/wayfinder/resolutions/decide-format-check-contract.md) and the [Deck format validation map](../planning/deck-format-validation/wayfinder/map.md).
