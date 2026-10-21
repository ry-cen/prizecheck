# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Pokémon TCG players who also collect. They build and play physical decks at league and locals, own more cards than any one deck uses, and keep those cards in boxes, binders and decks. Their job is to know exactly which copies they own and where each one is, so they can sleeve up a deck, lend or borrow cards for it, and trade in person without losing track. The value of the collection matters less to them than whether they can put a deck on the table.

Friends are the second audience: other collectors connected by a mutual friendship, who see each other's Collection (apart from Hidden Locations), Trade Lists, Loans and Trades.

The owner (the operator of the deployment) also uses owner-only review screens for catalog imports, corrections, missing-card reports and operational status.

## Product Purpose

PrizeCheck tracks the physical English Pokémon cards a collector owns: how many copies of each exact Card Edition, and which Location holds them. Collectors organize Locations into a tree, move copies between them, build Decks from their actual inventory, see what a Deck still needs (the Want List) and where to pick it from, and lend, borrow and trade those copies with Friends. Success means a collector trusts the app's count and location for every copy enough to act on it: pull cards from the right binder, hand over a loan, or confirm a trade swap.

## Positioning

Where every copy is. Inventory is physical: a Deck is a real storage place, so moving a card into a Deck moves that copy, and Decks, Loans and Trades all draw on the same exact copies, so nothing is counted twice. A deck builder's list or a value tracker's totals can't make that claim. Uncertainty is shown, not hidden: an unknown finish stays an Unspecified Variant, and format checks are advisory, never a claim of tournament legality.

## Operating Context

- Long sessions at a desk on a computer: sorting and moving cards, importing a collection or a decklist, building and checking Decks.
- A phone at league or locals: checking a Deck List, finding which binder holds a card, handing over a loan, confirming a trade swap.
- Trades and loan handovers happen in person. The app records the agreement and each side's confirmation; it does not ship cards or take payment. Cash on a Trade is an amount agreed between Friends.
- Collectors bring decklists and other trackers' export files from outside the app (Decklist Import, Collection Import), and send Want List cards to TCGplayer Mass Entry or a deck to TCG Live as text.
- The domain vocabulary is fixed in `CONTEXT.md` (Card Printing, Card Edition, Holding, Location, Storage Leaf, Deck, Deck List, Want List, Spare Copy, Loan, Trade, Trade List and so on). UI copy uses those terms.

## Capabilities and Constraints

- English-only catalog, imported on demand from TCGdex by the owner. It is incomplete: images and variant classifications can be missing, so the UI needs placeholders and an Unspecified Variant state.
- Built: Locations and Holdings, bulk move, removal and undo; the Collection view; Decks with Deck Lists, Target Format and advisory format checks; Want List and estimated costs from market prices, which exclude shipping and taxes; Published Decks (unlisted links or listed in `/discover`) as sanitized snapshots; Decklist and Collection Import; Friends, Handles, Invite Links and Blocks; Loans; Trades with cash, counters and Confirm swap.
- Sign-in uses email codes and Google or Discord OAuth. The first release is owner-only; public signup waits on email delivery readiness (`docs/signup-readiness.md`). Hosting and service providers are not yet chosen.
- Stack: React 19, TypeScript, Vite and Tailwind v4 on the project's own tokens (ADR 0012), a Python/FastAPI API, PostgreSQL and Better Auth.
- UI copy rule (AGENTS.md): collector screens show only what helps collectors decide or act. Data-source and marketplace names used as provenance, fetch or check times, cache and refresh state, internal reasons and record IDs stay out. Owner review screens and legally required credits are exempt.

## Brand Commitments

- PrizeCheck is the working name (replaced Starbirth on 2026-10-11).
- The Published Deck page carries a not-endorsed notice, which must stay.

## Evidence on Hand

- Product specs and decisions: `docs/planning/*/spec.md`, ADRs in `docs/adr/`, domain language in `CONTEXT.md`.
- No real users beyond the owner, testimonials, usage numbers, pricing or press exist yet. Future work must not invent any.

## Product Principles

1. The count is physical truth. Every number and Location in the UI must match what a collector would find in their boxes, binders and decks; a copy is never in two places or counted twice.
2. Show uncertainty, don't guess. Unknown variants, missing prices and advisory format checks say what is unknown, and never block collectors from recording what they own.
3. Get the deck to the table. Prioritize flows that turn a list into a sleeved deck: what is owned, where it is, and what to borrow, trade for or buy.
4. Friends are trusted, but privacy is the default. Friends see only what the sharing rules allow, never Location or Deck names, and the public sees only Published Deck snapshots.
5. Say only what helps collectors act. Keep system internals and provenance out of collector-facing copy.

## Accessibility & Inclusion

WCAG 2.2 AA is the standard, enforced by browser tests (`web/tests/workspace-accessibility.spec.ts`): axe checks, text contrast of at least 4.5:1 and outlines of at least 3:1 in the theme, focus rings on every keyboard stop with skip links, 24 px targets on desktop and 44 px on a phone, and transitions of 150 ms or less that stop under reduced motion. Touch-only users get a Select mode in place of mouse-only drag and marquee gestures.
