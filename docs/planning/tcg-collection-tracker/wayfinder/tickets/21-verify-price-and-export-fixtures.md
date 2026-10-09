# Verify live price and export fixtures

**Parent:** [Card prices and Deck exports — decision map](../card-prices-and-deck-exports-map.md)

**Label:** wayfinder:task

**Status:** closed — bounded planning investigation; Live acceptance unverified

**Assignee:** codex

**Blocked by:** [Investigate TCGdex prices and Edition mapping](16-investigate-tcgdex-pricing.md), [Investigate Live clipboard and TCGplayer Mass Entry contracts](17-investigate-deck-export-formats.md).

## Question

Can representative current source fixtures and destination behavior be verified before the plan promises compatibility? Obtain bounded first-party price samples covering normal, holo/reverse, special variant, Basic Energy, promo and unavailable data; inspect identity, currency, finish alias, price and provider timestamp. Capture actual Limitless clipboard text and a Mass Entry href. Verify prefill and, when an authorized Live client is available, import behavior for ordinary names, accents/punctuation, promos, Energy, and malformed or incomplete metadata. Record environment/date and documented/observed/unverified boundaries. This task gathers evidence to unblock design, not application implementation.

## Active completion criteria

The owner requested a similar Limitless deck comparison instead of opening the locked native Live client and authorized replacing the clipboard with the public reference list. [ADR: planning evidence scope](../../../../docs/adr/0005-deck-export-planning-evidence.md) replaces the active evidence criteria: bounded price cases, two similar rendered lists compared against the inspected formatter, the approved Copy action with its actual observation, and current Mass Entry prefill. Record unavailable byte capture and untested destination behavior explicitly. This is evidence for planning, not successful game compatibility acceptance.

## Historical limitation and criteria

Superseded for this planning investigation by the active criteria above; game and physical marketplace checks remain handoff prerequisites.

Initial sandboxed pricing reads failed, but approved read-only HTTPS reads subsequently produced [three representative live samples](../research/tcgdex-pricing-samples.json). Regular/reverse, holo and Basic Energy examples are observed; special/promo and known absence cases still need suitable verified IDs, and physical marketplace matching remains unproven. The export researcher verified Limitless's first-party clipboard formatter and Mass Entry href from source. Actual in-game import and Mass Entry destination prefill remain unverified. Preserve remaining limitations as explicit handoff prerequisites rather than inventing a passing result.

## Comments

Claimed by codex on 2026-10-08 after the owner requested the next Wayfinder ticket. Verify bounded representative source fixtures and attempt actual destination behavior where the available environment permits it. Do not close this task as a successful compatibility check if the Live client or destination cannot be exercised; retain specific unverified checks and evidence.

Resolved on 2026-10-08 under the owner's selected comparison scope. [Resolution: bounded price fixtures and public export comparison](../resolutions/21-verify-price-and-export-fixtures.md) links the captured price/DOM fixtures, reconstructed examples and full Mass Entry prefill screenshot. The approved Copy action showed Copied!, but actual clipboard bytes were unavailable. Actual Live import and exact physical matching remain unverified. No successful Live compatibility result is recorded.
