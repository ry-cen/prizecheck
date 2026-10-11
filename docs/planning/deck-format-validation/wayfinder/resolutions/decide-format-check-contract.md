# Resolution: Decide the format check result and endpoint contract

**Ticket:** [Decide the format check result and endpoint contract](https://github.com/ry-cen/prizecheck/issues/75)

**Resolved:** 2026-10-10, grilled with the owner.

**Builds on:** [Deck List model](decide-deck-list-model.md), [Reprint Groups](decide-reprint-groups.md), [Format Rules source](decide-format-rules-source.md), [Deck List migration](decide-deck-list-migration.md). The scope change is recorded in [ADR 0010](../../../../adr/0010-advisory-format-legality-in-scope.md).

## Endpoints

- **Private:** `GET /api/decks/{deck_id}/format-checks` returns results for Standard, Expanded and Gym Leader Challenge. `?format=` narrows the response to one format. This mirrors the separate Deck cost route and keeps Deck detail cheap.
- **Live with edits:** every command that changes a Deck List returns that Deck's format results in the same response, so legality updates without a second request.
- **Published:** a Published Deck's format results are recomputed on read for its fixed published cards, like prices. Reprint Groups and card attributes join the sanitized public catalog projection, so the read stays anonymous and never touches PostgreSQL. Results follow rotations and bans without republishing.
- **As of a date:** `?as_of=YYYY-MM-DD` evaluates against the dated rules on that day. The default is today. A future date carries a note that rules published after the current rules file are unknown.

## Result per format

- **Status:**
  - `not_legal` if any definite violation exists;
  - otherwise `unknown` if any gap exists;
  - otherwise `legal`.
- **Issues:** each issue has a stable code, a plain-language reason, and the Deck List lines it concerns. Unknowns are listed even when the status is `not_legal`.
  - **Deck issues:** size, ACE SPEC or Radiant count, GLC's single-type rule.
  - **Card issues:** not in the card pool, banned, over the copy limit, Rule Box or ACE SPEC in GLC, unknown attribute, regulation mark, or set date.
- **Traceability:** each response names the rules version it used (the rules file revision and its date).

## Composition with basic checks

Deck detail keeps the format-neutral basic checks (60 cards, 4 copies by Card Identity). Each format result applies its own size and copy rules, since GLC allows 1 copy. The API's basic-check disclaimer changes: it no longer says legality is not evaluated, and instead points to format checks as advisory.

## Stored results

Results are saved with the Deck, keyed by:
- the Deck List revision;
- the rules version;
- the card attribute and Reprint Group revision;
- the evaluation date.

A read reuses the saved result while every key part is unchanged, and recomputes when any changes. That includes a list edit, a rules deploy, a reviewed correction, or a date crossing a rotation, set-legality or ban boundary. Nothing re-evaluates existing Decks in bulk, and notifying collectors of legality changes is out of scope.

Checks are computed in full. Incremental checking is added only if a measurement misses the latency budget below.

## Acceptance criteria

1. Rare Candy sv01-191 (mark G), swsh1-180 (mark D) and swsh12.5-141 (no mark) share Rare Candy me01-125's text, so they are in its Reprint Group and are Standard legal through it (me01-125 carries mark I). Rare Candy sm1-129's text differs from me01-125's, so sm1-129, sm2-165 and sm7-142 form their own group and are not legal until a maintainer merges that group into me01-125's through a reviewed Reprint Group merge (ticket 14, #95); after the merge sm1-129 is Standard legal.
2. A Pokémon printing that isn't legal on its own mark is Standard not legal even when an identical reprint is legal. This uses a fixture, since no real case may exist.
3. A card from a set with no recorded legal date yields unknown with the reason "set legality date not recorded".
4. An identical reprint of a banned Expanded printing is Expanded not legal.
5. "Professor's Research (Professor Juniper)" ×3 with "Professor's Research (Professor Magnolia)" ×2 breaks the 4-copy limit.
6. A GLC deck is not legal with Pokémon of two types, a Rule Box Pokémon, or an ACE SPEC. Basic Energy in any quantity is legal.
7. Cutting a Deck List line returns updated results in the same response, and an unchanged second read reuses the saved result.
8. Checking `as_of` the day before and the day after a rotation date flips Standard legality for the affected marks.
9. A Published Deck's format results load anonymously without a PostgreSQL connection and change after a rotation without republishing.
10. **Latency:** a 60-line Deck List's full check meets a p95 budget of 200 ms. The spec sets the bound for very large Deck Lists.
