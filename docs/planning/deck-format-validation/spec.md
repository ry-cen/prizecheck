# Deck Lists and format validation

**Status:** ready for implementation planning; testing seams confirmed with the owner on 2026-10-10.

**Label:** ready-for-agent

**Sources:**
- [Deck format validation decision map](wayfinder/map.md) and its resolutions
- [ADR 0009](../../adr/0009-deck-list-is-part-of-the-deck.md): a Deck List is part of the Deck
- [ADR 0010](../../adr/0010-advisory-format-legality-in-scope.md): advisory format legality is in scope
- Research on [Standard and Expanded rules](wayfinder/research/standard-and-expanded-rules.md), [Gym Leader Challenge rules](wayfinder/research/gym-leader-challenge-rules.md) and [TCGdex legality data](wayfinder/research/tcgdex-legality-data.md)

## Problem Statement

A Deck can only contain cards I physically own and have moved into it. When I build a new deck I usually don't have every card yet. Some are in a binder or another Deck, and some I'd have to buy. The app gives me nowhere to write down the deck I intend to play, no way to see which cards I'm missing or where the ones I own are, and no way to share a deck I haven't finished collecting.

I also can't tell whether a deck is legal to play. The app checks only 60 cards and four copies per name, and says that Standard eligibility, rotation and bans are not evaluated. Pokémon legality is genuinely intricate:
- regulation marks rotate every year;
- older printings stay legal through identical reprints;
- Expanded has a ban list naming specific printings;
- Gym Leader Challenge allows one copy per name, one Pokémon type, and no Rule Box or ACE SPEC cards.

The catalog's source data gets several of these wrong. TCGdex's legality flags ignore reprints and McDonald's cards, and contain Expanded ban errors. Some cards lack regulation marks or have no reliable Rule Box or ACE SPEC marker, and manually approved Printings carry no metadata at all.

## Solution

Every Deck gains a Deck List: the Card Editions and quantities I intend the deck to contain, whether I own them or not. A Deck is still one thing in my Location tree. Its physical Holdings and its Deck List are two parts of it.

- **Ownership states.** For each line I see how many copies are *in this Deck*, *elsewhere* in my Collection (and where), or *not owned*. Cards in the Deck that I've cut from the list show as surplus.
- **Pick List.** It tells me where to fetch the cards I own elsewhere, preferring loose storage and the fewest Locations. Confirming one row, a selection, or everything moves those copies into the Deck.
- **Moving and deleting.** Moving cards into a Deck adds them to its list. Deleting a Deck returns its cards to Unsorted.
- **Cost and exports.** I see what the whole deck costs and what it costs to complete. I can export it to Pokémon TCG Live, or send just the cards I don't own to TCGplayer Mass Entry.
- **Publishing.** Publishing snapshots the Deck List, so a shared deck may include cards I don't own. A Published Deck stays live after I delete its Deck, until I revoke it.

Each Deck List is checked against Standard, Expanded and Gym Leader Challenge.
- **Results.** Each format gives an advisory result: *legal*, *not legal* with reasons, or *unknown* with reasons. Results are never a guarantee and never block anything.
- **Freshness.** Results update with every list edit and follow rotation and ban dates automatically. They are also shown on Published Decks.
- **Reprints.** An old printing of a legal Trainer or Energy counts as legal through its Reprint Group.
- **Rules data.** Rules come from dated rules files the owner maintains. When data is missing, the answer is *unknown*, never *legal*.

## User Stories

### Deck Lists

1. As a deck builder, I want to add a card I don't own to a Deck's Deck List, so that I can plan a deck before I've collected it.
2. As a deck builder, I want every Deck List line to name a specific Card Edition and quantity, so that prices, exports and ownership are exact.
3. As a deck builder, I want to add a card by its Card Printing alone and have the cheapest priced Edition chosen for me, so that I don't have to pick a variant when I don't care.
4. As a deck builder, I want the app to fall back to the first Edition in catalog order when no Edition of a Printing has a price, so that I can always add the card.
5. As a deck builder, I want the response to tell me whether an Edition was chosen by cheapest price or by catalog order, so that I understand why I got that variant.
6. As a deck builder, I want an Edition chosen for me to stay fixed when prices change later, so that my list doesn't change under me.
7. As a deck builder, I want to change a line's quantity or remove it, so that I can iterate on the deck.
8. As a deck builder, I want to create a Deck that holds no cards yet, so that I can theorycraft in the same place I store real decks.
9. As a collector, I want a Deck and its Deck List to appear as one entry in my Location tree, so that my Collection never shows the same deck twice.
10. As a collector, I want Deck List lines never to count toward my Collection, so that planned cards don't inflate what I own.

### Ownership and the Pick List

11. As a deck builder, I want each line to show how many copies are in this Deck, so that I know what's already sleeved.
12. As a deck builder, I want each line to show how many copies are elsewhere in my Collection and in which Locations, so that I know what I can fetch.
13. As a deck builder, I want each line to show how many copies I don't own, so that I know what to acquire.
14. As a deck builder, I want ownership states computed from my current Holdings every time, so that they're never stale.
15. As a deck builder, I want to be warned when several Decks want the same spare copies, so that I don't count one card twice across decks.
16. As a deck builder, I want a Pick List of the cards I own elsewhere, with a suggested source Location for each, so that I can gather the deck physically.
17. As a deck builder, I want the Pick List to prefer loose storage and the fewest Locations, so that I make as few trips as possible.
18. As a deck builder, I want copies in other Decks suggested only when loose storage runs out, with a warning that taking them leaves that Deck short, so that I don't break a built deck by accident.
19. As a deck builder, I want to change the suggested source of any Pick List row, so that I can take the copies I actually reach for.
20. As a deck builder, I want to confirm one Pick List row, a selection, or all rows at once, so that the app records the cards I've physically retrieved.
21. As a deck builder, I want each confirmation to be an ordinary Move into the Deck, so that inventory history and undo behave as they always have.

### Keeping Holdings and the Deck List in step

22. As a collector, I want moving a card into a Deck to add it to the Deck List when no line covers it, so that the list reflects what I put in.
23. As a collector, I want moving a card out of a Deck to leave its line, so that the deck still remembers it needs that card.
24. As a deck builder, I want editing a Deck List never to move physical cards on its own, so that my inventory changes only when I say so.
25. As a deck builder, I want to cut a line below the copies the Deck holds, so that I can revise a deck without handling cards first.
26. As a deck builder, I want surplus copies shown as in the Deck but not on the list, with a suggestion to put them away, so that I can tidy up later.
27. As a deck builder, I want putting surplus away to be a Move to a Location I choose, so that cards go where I want them.

### Deleting Decks

28. As a collector, I want deleting a Deck to move all of its Holdings to Unsorted, so that cards never disappear with a deck.
29. As a collector, I want deleting a Deck to discard its Deck List, so that abandoned plans don't linger.

### Existing Decks

30. As a collector with existing Decks, I want each to get a Deck List built from its Holdings, so that everything keeps working after the change.
31. As a collector, I want Holdings of an Unspecified Variant Edition to become lines naming that Edition, so that the conversion never guesses a variant.

### Basic construction checks

32. As a deck builder, I want the 60-card and four-copy checks to read the Deck List, so that they describe the deck I intend.
33. As a deck builder, I want subtitled reprints such as "Professor's Research (Professor Juniper)" and "Professor's Research (Professor Magnolia)" to count as one name, so that copy limits are correct.
34. As a deck builder, I want the basic checks' disclaimer to point me to format checks rather than say legality isn't evaluated, so that the API's wording matches what it can do.

### Format checks

35. As a deck builder, I want to check a Deck List against Standard, Expanded and Gym Leader Challenge in one request, so that I see all three at once.
36. As a deck builder, I want to ask for a single format, so that I can focus on the one I play.
37. As a deck builder, I want every Deck List edit to return updated format results in the same response, so that legality updates instantly.
38. As a deck builder, I want each format to say legal, not legal, or unknown, so that I know where the deck stands.
39. As a deck builder, I want any definite violation to make a format not legal, even if other cards are unknown, so that real problems aren't hidden.
40. As a deck builder, I want unknowns listed alongside violations, so that I can see everything at once.
41. As a deck builder, I want each issue to name the Deck List lines it concerns and give a plain-language reason, so that I know what to fix.
42. As a deck builder, I want deck-level issues (size, ACE SPEC count, Radiant count, GLC's single type) reported separately from card issues, so that I can tell structure from individual cards.
43. As a Standard player, I want cards legal by their regulation mark and set legal-from date, so that rotation and new releases are respected.
44. As a Standard player, I want an older Trainer or Energy printing to count as legal when a functionally identical printing in its Reprint Group is legal, so that my old Rare Candy is playable.
45. As a Standard player, I want a Pokémon printing to be legal only on its own mark, so that the app doesn't assume a ruling the official sources don't make.
46. As an Expanded player, I want the Black & White-onward pool, marks D and later, and the McDonald's and Trainer Kit extras recognised, so that legal cards aren't rejected.
47. As an Expanded player, I want a ban on one printing to cover its whole Reprint Group, so that a banned card can't sneak in through a reprint.
48. As a Gym Leader Challenge player, I want one copy per name except Basic Energy, so that the singleton rule is enforced.
49. As a Gym Leader Challenge player, I want {Boss's Orders, Lysandre} and {Professor's Research, Sycamore, Juniper} each to count as one card, so that GLC's grouping rule is enforced.
50. As a Gym Leader Challenge player, I want Pokémon of more than one type flagged, with a dual-type card counting if either type matches, so that the single-type rule is enforced correctly.
51. As a Gym Leader Challenge player, I want Rule Box Pokémon, ACE SPEC cards and Prism Star cards flagged, so that GLC's exclusions are enforced.
52. As a deck builder, I want ACE SPEC (one per deck), Radiant (one per deck) and Prism Star (one per name) limits checked, so that per-deck limits are enforced.
53. As a deck builder, I want an unknown result with a reason when a card's set has no recorded legal date, so that stale rules don't call my deck illegal.
54. As a deck builder, I want an unknown result when a regulation mark isn't in the rules, so that a future mark isn't treated as illegal.
55. As a deck builder, I want an unknown result when a card lacks an attribute the format needs, so that missing data is never read as legal.
56. As a deck builder, I want to check a Deck List as of a date, so that I can preview an announced rotation.
57. As a deck builder, I want a future-date check to warn that rules published after the current rules file are unknown, so that I don't over-trust a preview.
58. As a deck builder, I want each result to name the rules version it used, so that a result can be explained later.
59. As a deck builder, I want results saved and reused while nothing they depend on has changed, so that checks stay fast.
60. As a deck builder, I want results recomputed after a list edit, rules update, reviewed correction, or rotation, ban or set-legality date, so that a saved result is never stale.

### Cost and exports

61. As a deck builder, I want the Deck List cost of every line, so that I know what the whole deck is worth.
62. As a deck builder, I want the cost to complete of only the cards I don't own, so that I know what I'd need to spend.
63. As a deck builder, I want copies I own elsewhere excluded from the cost to complete, so that I'm not told to buy cards I have.
64. As a deck builder, I want both figures to keep quantity-weighted coverage and never count an unknown price as $0, so that the estimates stay honest.
65. As a deck builder, I want the Pokémon TCG Live export to contain the whole Deck List, so that I can play the deck I intend.
66. As a deck builder, I want TCGplayer Mass Entry to default to the cards I don't own, so that I can buy exactly what I'm missing.
67. As a deck builder, I want the option to send the whole Deck List to Mass Entry, so that I can price the full deck too.

### Publishing

68. As a deck owner, I want a Published Deck to snapshot my Deck List, so that I can share a deck I haven't finished collecting.
69. As a deck owner, I want a Published Deck never to reveal what I own or where it's stored, so that my Collection stays private.
70. As a visitor, I want to see a Published Deck's format results, so that I know whether the shared deck is legal.
71. As a visitor, I want those results to follow rotations and bans without the owner republishing, so that a public page doesn't keep claiming stale legality.
72. As a deck owner, I want existing Published Decks to keep working unchanged, so that shared links don't break.
73. As a deck owner, I want a Published Deck to stay live after I delete its Deck, so that deleting my storage doesn't take down a shared page.
74. As a deck owner, I want to revoke a Published Deck or change its visibility after its Deck is deleted, so that I stay in control of it.

### Rules and card data maintenance

75. As the maintainer, I want each format's rules in a dated, versioned file updated by commit, so that rule changes are reviewed, tested and traceable.
76. As the maintainer, I want rules to carry effective dates, so that rotations, bans and new sets take effect on the right day without same-day edits.
77. As the maintainer, I want the test gate to check that every rules file parses, is dated and covers every imported set, so that a broken or stale rules file is caught.
78. As the maintainer, I want card attributes derived from TCGdex by rules kept in the repository, so that fixing a class of errors is one commit.
79. As the maintainer, I want to correct one printing's attributes through a reviewed record, so that individual data errors, such as Special Energies labelled Basic, are fixed.
80. As the maintainer, I want manually approved Printings to get attributes only through review, so that cards without source data aren't guessed.
81. As the maintainer, I want printings with identical text in the same Card Identity grouped into Reprint Groups automatically, so that the bulk of reprints need no work.
82. As the maintainer, I want to merge reworded or errata'd printings into a Reprint Group and split wrong groups through review, so that functional identity is right.
83. As the maintainer, I want to merge Card Identities for names the subtitle rule misses, so that copy limits are right for odd cards.
84. As a collector, I want the Basic Energy exemption to use reviewed attributes, so that Special Energies mislabelled as Basic aren't exempted.

## Implementation Decisions

### Domain model

- **Deck List** is part of a Deck (ADR 0009), not a separate object, and the Deck stays a Storage Leaf. A Deck List line holds one Card Edition and a positive quantity, with at most one line per Edition per Deck. "Any Edition" and identity-level lines are not supported.
- **Card Identity** derivation strips a trailing parenthetical subtitle from the English name. A maintainer-reviewed merge can join Card Identities.
- **Reprint Group** is new: the Card Printings within one Card Identity whose rules text is functionally identical.
  - Groups form automatically from exact text equality: the effect text for Trainers and Energy; HP, types, attacks and abilities for Pokémon.
  - Maintainer-reviewed records merge or split groups.
  - Manual Printings join only through review.
- **Card attributes** for each printing are regulation mark, card kind, Basic Energy status, types, and Rule Box, ACE SPEC, Radiant and Prism Star status.
  - They're derived from catalog source fields by derivation rules kept in the repository, such as Rule Box from suffix, stage and name, and ACE SPEC from rarity plus a listed set of Black & White ACE SPECs.
  - Maintainer-reviewed per-printing corrections override the derivation.
  - Reviews follow the existing pattern: collector reports are unapproved input, and only the owner's approval-coded decision changes data.
  - A revision counter covers both attributes and Reprint Groups.
- **Format Rules** live in one dated, versioned file per format in the repository. Each file holds:
  - legal regulation marks with their legal windows;
  - the card pool (sets with legal-from dates, mark ranges, and extras such as McDonald's and Trainer Kit products);
  - ban lists by printing with effective dates;
  - copy and per-deck limits;
  - Gym Leader Challenge's single-type rule, exclusions and cross-name groups;
  - the Pokémon reprint-inheritance flag, initially off.

  The rules version (file revision and date) is exposed in results. TCGdex `legal` flags are never used.
- The Basic Energy exemption in basic and format checks reads the reviewed Basic Energy attribute rather than the raw source energy type.

### Format evaluator

- A pure evaluator takes four inputs:
  - Deck List lines, each resolved to its Card Printing, Card Identity, Reprint Group and attributes;
  - the format's rules;
  - Reprint Group legality facts;
  - an evaluation date.

  It returns one result per format. It has no database or network access, like the existing pure construction-check evaluator.
- **Legality per printing:**
  - legal if its own mark or set is legal on the date;
  - otherwise, for Trainers and Energy, legal if any printing in its Reprint Group is legal;
  - otherwise not in the pool;
  - unknown when the deciding data is missing (set date not recorded, mark not in rules, attribute missing).
- **Bans** apply to the banned printing's whole Reprint Group.
- **Copy limits** count by Card Identity: 4 in Standard and Expanded, 1 in Gym Leader Challenge with its cross-name groups. Basic Energy is exempt. Copy limits never count by Reprint Group.
- **Result shape per format:**
  - status: `legal`, `not_legal` or `unknown`. Any definite violation means `not_legal`; otherwise any gap means `unknown`.
  - issues: each has a stable code, a plain-language reason, an issue kind (deck or card) and the affected Deck List lines.

  The response also carries the rules version and the evaluation date.

### API contract

- `GET /api/decks/{deck_id}/format-checks` returns Standard, Expanded and Gym Leader Challenge results.
  - `?format=` narrows the response to one format.
  - `?as_of=YYYY-MM-DD` evaluates on that date, defaulting to today. A future date includes a note that later rules are unknown.
  - The owner check behaves like the other Deck routes: another owner gets 404.
- Deck List commands are idempotent and revision-checked, like existing Location and Deck commands. They add a line, add by Printing (cheapest-Edition default), change a quantity, and remove a line, and each returns the Deck's updated Deck List and format results. The add-by-Printing response says which rule chose the Edition.
- Deck detail returns the Deck List with each line's ownership states: *in this Deck*, *elsewhere* (by Location), and *not owned*. It also returns surplus Holdings not on the list and warnings when Decks compete for the same spare copies. Basic checks read the Deck List. Their disclaimer no longer says legality is not evaluated and instead points to advisory format checks.
- **Pick List route.** It returns a Deck's cards that are elsewhere in the Collection, each with a suggested source.
  - Suggestions take non-Deck Storage Leaves first, fewest Locations first, then other Decks with a shortfall warning.
  - Confirming one, several or all rows performs Moves into the Deck through the existing Move contract, with sources the collector may override.
- **Moves and Holdings.** A Move or Holding increase into a Deck adds or raises Deck List lines so the moved copies are covered. Removals leave lines untouched. A put-away suggestion for surplus copies is a Move to a collector-chosen Location.
- **Deleting a Deck** moves all of its Holdings to Unsorted in the same transaction and discards its Deck List. Other Location deletion rules are unchanged.
- **Deck cost** returns two figures: Deck List cost (every line) and cost to complete (*not owned* lines only). Both keep the existing quantity-weighted coverage, labels and refresh behavior.
- **Exports:**
  - The Pokémon TCG Live export reads the whole Deck List.
  - TCGplayer Mass Entry takes a scope, defaulting to not-owned lines, with the whole Deck List as the alternative.
- **Publishing** snapshots the Deck List lines as frozen Card Edition and quantity rows. Existing snapshots already have this shape and stay valid.
- **Publication independence:**
  - A publication's link to its Deck becomes optional.
  - Deleting the Deck clears the link and keeps the publication live.
  - Owner routes keyed by the public token revoke a publication or change its visibility, and work with or without a Deck.
  - A publication without a Deck can't be republished.
  - At most one active publication per existing Deck still applies.
- **Published Deck format results** are served by an anonymous public route keyed by token and version, like Published Deck cost.
  - Results are recomputed on read for the fixed published rows.
  - The route reads Card Identity, Reprint Group and attribute facts from the sanitized public catalog projection, which gains those facts, and never opens a PostgreSQL connection.

### Saved results

- Format results are saved with the Deck, keyed by:
  - the Deck List revision;
  - the rules version;
  - the attribute and Reprint Group revision;
  - the evaluation date, normalised to the next rule boundary so that a result stays reusable until a rotation, ban or set-legality date changes it.

  A read whose key matches reuses the saved result; any other read recomputes and saves. Nothing re-evaluates in bulk.
- Checks run in full each time. Incremental checking is added only if the latency criterion below is missed.

### Schema and data changes

- New storage covers:
  - Deck List lines;
  - saved format results;
  - Reprint Group membership with review records;
  - card attribute corrections with review records;
  - Card Identity merges.
- **Conversion.** A one-time conversion builds each existing Deck's Deck List from its Holdings, one line per Edition at the held quantity, Unspecified Variant included.
- **Card Identity re-derivation** with subtitles stripped preserves every Holding, Deck List and Published Deck reference. Merged identities keep a surviving ID, and no frozen snapshot content changes.
- **Publications.** The publication-to-Deck reference becomes nullable and is cleared on Deck deletion. The uniqueness rule applies only while the link is set.

## Testing Decisions

- **What makes a good test.** Tests assert externally observable behavior: HTTP status, response bodies, inventory effects visible through other routes, and anonymous public responses. They don't assert internal tables or function calls. Each acceptance case is proven at the highest seam that can observe it.
- **Seams, confirmed with the owner:**
  1. **Private HTTP API against migrated PostgreSQL** (existing): Deck List commands and their returned results, ownership states, Moves extending the list, surplus after cuts, Pick List confirmations, Deck deletion into Unsorted, conversion of existing Decks, format-checks with `as_of` and saved-result reuse, both cost figures, both exports with Mass Entry scope, and publication management by token after deletion. Prior art: the Deck, Move, Holding, Deck cost, export and publication tests.
  2. **Anonymous public HTTP** (existing): Published Deck format results load without a PostgreSQL connection and change after a rotation without republishing. Prior art: the Published Deck cost and public projection tests.
  3. **Catalog import fixture** (existing): attribute derivation, automatic Reprint Groups, subtitle-stripped Card Identity, and maintainer-reviewed corrections, merges and splits through the review routes. Prior art: the catalog metadata, reconciliation and metadata review tests.
  4. **Pure format evaluator** (new, the only new seam): the rules matrix is covered with fixture rules and attributes. HTTP tests then prove one or two cases of each kind end to end. Prior art: the existing pure construction-check evaluator.
- **Rules-file check in the test gate:** each real rules file parses, every entry is dated, and every imported set has a legal-from date or an explicit exclusion.
- **Acceptance criteria:**
  1. Rare Candy sm1-129 is Standard legal through its Reprint Group (me01-125 carries mark I).
  2. A Pokémon printing that isn't legal on its own mark is Standard not legal even when an identical reprint is legal. This uses a fixture, since no real case may exist.
  3. A card from a set with no recorded legal date yields unknown with the reason "set legality date not recorded".
  4. An identical reprint of a banned Expanded printing is Expanded not legal.
  5. "Professor's Research (Professor Juniper)" ×3 with "Professor's Research (Professor Magnolia)" ×2 breaks the four-copy limit.
  6. A GLC deck is not legal with Pokémon of two types, a Rule Box Pokémon, or an ACE SPEC. Basic Energy in any quantity is legal.
  7. Cutting a Deck List line returns updated results in the same response, and an unchanged second read reuses the saved result.
  8. Checking `as_of` the day before and the day after a rotation date flips Standard legality for the affected marks.
  9. A Published Deck's format results load anonymously without a PostgreSQL connection and change after a rotation without republishing.
  10. A 60-line Deck List's full check meets a p95 of 200 ms through the real gateway. A bound for very large Deck Lists is set during implementation planning. These tests are marked `serial`, per the verification guide.

  Further criteria follow the user stories: Pick List ordering and override, confirmation of one, selection and all, surplus and put-away, deletion into Unsorted, conversion fidelity including Unspecified Variant, cheapest-Edition choice and fallback reporting, both cost figures, Mass Entry scope, and publication survival and management after deletion.
- Final acceptance runs the full verification gate once, and evidence quotes its summary counts.

## Out of Scope

- Web UI changes. The owner's planned UI overhaul presents Deck Lists, Pick Lists and format results.
- Pasted or imported decklists from outside the app.
- Formats other than Standard, Expanded and Gym Leader Challenge.
- Any guarantee of tournament legality. Results are advisory and never block editing, moving or publishing.
- A social network where collectors request the cards their Deck Lists don't own, and the identity-level ("any printing") lines it would need. The Deck List design must not rule it out.
- Database-editable Format Rules with an owner API.
- Notifying collectors when a rule change alters a Deck's legality.
- Reporting catalog data errors upstream to TCGdex.
- Excluding digital-only Pokémon TCG Pocket cards from the catalog, which is a separate task.

## Further Notes

- **Branch.** This builds on the card prices and Deck exports feature, now on `dev`, which supplies the catalog source metadata, Deck cost, both exports, metadata reviews and the public projection. `feature/deck-format-validation` is based on `dev`, rebased on 2026-10-10 after the prices branch landed.
- **Collector workspace.** The [Collector workspace spec](https://github.com/ry-cen/prizecheck/issues/79) plans atomic multi-source Moves. Pick List "confirm all" gathers copies from several Locations, so it should use that operation if it lands first, or stay compatible with it.
- **Open rules facts**, to settle when writing the initial rules files:
  - the J mark's exact legal date;
  - the full Expanded set list (settled on 2026-10-11 from the Tournament Handbook revision of 2026-09-01; see `api/app/format_rules/expanded.toml`, where Classic Collection sets stay unknown);
  - marks on the physical 30th Celebration and McDonald's 2021–2024 cards;
  - Basic Fairy Energy in Standard;
  - Expanded legality of SM promos 1–157 (still open: the handbook lists SM 158 and higher, but the ban list names Marshadow SM85, so these promos check unknown);
  - ACE SPECs in Mega Evolution sets.

  Until a fact is settled, the affected cards yield unknown.
- **Superseded MVP exclusion.** The MVP spec's exclusion of format legality and the promise in its user story 72 are superseded by ADR 0010.
