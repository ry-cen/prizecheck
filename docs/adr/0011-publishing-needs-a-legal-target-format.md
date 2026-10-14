# Publishing needs a legal result in the Deck's Target Format

**Status:** accepted; planning decision, not yet implemented. Supersedes the "never blocks publishing" part of [ADR 0010](0010-advisory-format-legality-in-scope.md). Everything else in ADR 0010 still applies.

The owner decided this on 2026-10-12, in [Decide the Published Deck and Discover pages](https://github.com/ry-cen/prizecheck/issues/127).

Every Deck has one **Target Format** (Standard, Expanded or Gym Leader Challenge). It is Standard unless the collector chooses another, and existing Decks become Standard. A Deck shows only its Target Format's advisory result. Changing the Target Format is how a collector checks another format.

**Publishing and republishing need a `legal` result in the Target Format.** `not_legal` blocks, and so does `unknown`, even though `unknown` only means the rules or card data are missing. Editing a Deck List and moving cards are never blocked.

A Published Deck freezes its Target Format with its snapshot. Its result keeps following rotations, bans and rules updates. When a published snapshot stops being legal (rotation, a ban, a rules or data update), it stays reachable by its link and shows the current result, but it **leaves Discover** until it is legal again. Republishing is blocked meanwhile. The same applies to Published Decks that exist when this ships.

## Considered options

- **Keep publishing ungated (ADR 0010).** Rejected: the owner wants Discover to hold only decks that can be played in their format.
- **Let `unknown` publish, and block only `not_legal`.** Rejected by the owner. The cost is that decks with brand-new sets or unreviewed cards can't be published until the rules files and card data catch up.
- **Take down Published Decks that stop being legal.** Rejected: shared links would break at every rotation. Leaving Discover is enough.
- **Check all three formats on every Deck.** Rejected: a Deck is built for one format, and one result is clearer.
