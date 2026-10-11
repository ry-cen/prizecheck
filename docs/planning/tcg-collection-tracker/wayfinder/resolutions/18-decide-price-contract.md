# Resolution — Card-price presentation and Estimated Deck Cost

**Decision:** accepted by the owner on 2026-10-08 with “yes to all” for the price-contract round.

**Ticket:** [Decide card-price presentation and Deck cost](https://github.com/ry-cen/tcg-tracker/issues/37).

## Price meaning and surfaces

Use USD TCGplayer market prices obtained through TCGdex for the exact physical Card Edition. Display the unit quote in catalog/card information and alongside Holdings, including private and Published Deck card information. Show its source timestamp or an unavailable/unknown-age state. Do not substitute another finish, a cheaper Printing, or a different Card Identity.

Call the aggregate **Estimated Deck Cost**. It is the sum of each included unit market quote multiplied by the number of that Edition's copies in the Deck. It excludes shipping and taxes and is not the collector's acquisition cost or a checkout total. No condition/grading adjustment is introduced.

## Unavailable or uncertain prices

Unspecified Variants and uncertain marketplace matches remain unpriced. A missing quote is unavailable, not $0. Exclude those copies from the subtotal and report the gap through **Pricing Coverage**. A known quote for a normal finish must not price an Edition whose finish is unknown. No user price/finish override or automatic physical-identity change is authorized by this decision.

The aggregate uses all copies in the selected Deck, not only the currently loaded page. Pricing Coverage is the number of copies with an included quote divided by all copies in the Deck; it is not a count of distinct names or Editions. When coverage is incomplete, explicitly label the amount as a priced subtotal, for example “Estimated Deck Cost: $42.30 subtotal · 56/60 cards priced.”

An empty Deck can show a $0.00 subtotal with “No cards.” A nonempty Deck with no included quotes shows “Price unavailable · 0/N cards priced,” rather than suggesting its cost is $0.00.

## Freshness and retained quotes

**Current schedule:** [Access-triggered price refresh](../../../../adr/0006-access-triggered-price-refresh.md) supersedes the original daily schedule and owner Refresh prices control. The [accepted refresh contract](22-decide-price-refresh-boundary.md) holds the automatic-only access, one-hour/24-hour/three-second behavior, shared bounded work and confirmed-absence policy. No users have manual price refresh. Displayed card prices and complete private/Published Deck costs count as access, including public visitors; no daily fallback updates unaccessed cards. Numeric workload/retry limits and the public-only projection mechanism remain for `/to-spec` and the Published Deck decision. The source-age and retained-quote-on-failure rules below remain accepted; confirmed source unavailability supersedes an older quote as specified in the refresh contract.

Continue showing and including the last known quote when refresh fails, provided its Edition mapping remains defensible. Mark a quote **stale** when its provider pricing timestamp is more than 48 hours old. Do not use the card metadata update time or a recent application fetch to make an old quote appear fresh. If the source pricing timestamp is absent or unusable, show **Age unknown**; a fetch timestamp may be shown separately but cannot establish price age.

Stale and unknown-age quotes remain in the priced subtotal and Pricing Coverage. Show the quantity of copies with stale quotes and, when present, unknown-age quotes. Their freshness labels must be visible with the aggregate as well as per-card information; do not present a mixed-age total as uniformly current. A later invalidation of the physical marketplace match makes the Edition unpriced even if an old number is retained internally.

## Worked acceptance example for the later handoff

A six-card Deck contains three copies quoted at $0.25 with a fresh source timestamp, two copies quoted at $0.43 with a timestamp over 48 hours old, and one Unspecified Variant with no defensible quote. Show a $1.61 priced subtotal, 5/6 cards priced, and 2 cards with stale quotes. The unpriced copy contributes no dollar amount and is still included in the denominator. A refresh failure retains this estimate and its actual freshness labels.

## Boundaries and remaining decisions

Published Decks support these prices and aggregate semantics. The owner already chose refreshed quotes for the fixed published cards. Private edits must not change public card quantities. [Published Deck prices and compatibility](https://github.com/ry-cen/tcg-tracker/issues/39) owns the public-object behavior and migration; this resolution does not replace that contract.

[Price refresh scope and workload bounds](https://github.com/ry-cen/tcg-tracker/issues/41) is now unblocked. [Marketplace metadata separation and Edition compatibility](https://github.com/ry-cen/tcg-tracker/issues/42) owns defensible mapping rules and preservation of existing identities. [Live price and export fixtures](https://github.com/ry-cen/tcg-tracker/issues/40) retains unverified source/destination evidence. Export defaults and fallbacks remain in [Deck export precision and fallback](https://github.com/ry-cen/tcg-tracker/issues/38).

This is an accepted product decision, not application implementation, a validated production feed, or a completed specification. The existing three live price samples and earlier architect review remain evidence with their stated limitations. No additional agent delegation or application tests were necessary to record the owner's answers.

## Historical refresh schedule

Superseded by [ADR: access-triggered price refresh](../../../../adr/0006-access-triggered-price-refresh.md) on 2026-10-08: “Refresh locally stored price information daily and provide an owner Refresh prices control. Opening a card or Deck does not require a live TCGdex request. Refresh scheduling, workload bounds and the public projection mechanism remain separate design decisions.”
