# Research — Pokémon TCG Live's deck builder

**For:** [Prototype the Deck experience](https://github.com/ry-cen/prizecheck/issues/125). On 2026-10-12 the owner asked for a builder like TCG Live's:
- a library of cards you can add, showing owned cards by default with a toggle to include unowned ones;
- cards dragged into a deck area.

**Gathered:** 2026-10-12. TCG Live's in-client help isn't public, and Bulbapedia and Pokémon Support refused automated fetches (403), so this rests on Pokémon's news posts, the official forums and third-party guides. Each claim notes its source. Where nothing confirmed a detail, it is marked unconfirmed.

## What TCG Live does

**Layout**
- The **card library takes most of the screen**, and the **deck sits in a narrow side panel**. A forum post asks for the two to swap space, because the deck is the focus. [Forum: deck builder and card library issues][forum-3829]
- Landscape layouts (desktop, and tablets since a 2024 update) show **deck validation above the deck's card grid**. [Pokémon news][news]
- A **full-screen deck view** shows the whole list at once and can export it. [Forum: enhanced Deck Editor][forum-24855]

**Owned and unowned cards**
- The library has an ownership filter. A player describes it as all / not owned / owned. This is a user report and unconfirmed. [Forum: how to get specific cards][forum-18020]
- Unowned cards **appear darkened**, and the invalid icon is kept for cards that are actually invalid. Unowned, uncraftable and invalid cards each have their own look. Unowned variants are darkened in the rarity menu. [Pokémon news][news], [Forum: enhanced Deck Editor][forum-24855]
- A deck **may hold cards you don't own** while you edit it, but it is only valid to play once you own them. Missing cards can be **exchanged for Trade Credits** inside the editor, and "Exchange All" covers every unowned card at once. [Pokémon Support][support] (from search excerpts), [Forum: enhanced Deck Editor][forum-24855]
- When you import a list, it can **auto-select owned cards or the rarest owned cards**. [Pokémon news][news]

**Adding cards**
- Players describe adding cards with **plus and minus controls under a card** ("Available") and choosing a variant from a **rarity or variant drawer**. [Forum: special cards in TCG Live][forum-7229]
- **Unconfirmed: dragging.** None of the sources found confirm drag and drop in TCG Live's editor. Its predecessor, TCG Online, used two windows, collection and deck, and you **dragged cards from the collection into the deck**. [Giant Bomb: PTCGO][giantbomb]

**Known complaints**
- Cards in the deck aren't grouped logically: evolution lines are split up, and Items, Tools, Stadiums and Supporters are mixed together. [Forum: deck builder and card library issues][forum-3829]
- Only default artworks show.
- Search needs exact text. [Forum: deck builder and card library issues][forum-3829]

## What this means for PrizeCheck

- **Taking a card is a plan, not a move.** In TCG Live, a card in a deck is the card you own. In PrizeCheck a Deck List line is a plan: dragging a card in **adds or raises a line and never moves a physical card**. This is user story 24 of the Deck List spec. The owned library should therefore show where copies are and how many are free, and gathering stays a separate step afterwards.
- **"Exchange" becomes buying.** PrizeCheck has no crafting. The closest match is cost to complete and TCGplayer Mass Entry for not-owned lines, and they belong where TCG Live puts Exchange All.
- **Fix TCG Live's complaints instead of copying them:**
  - give the deck more room;
  - group it by evolution line and by Trainer subtype;
  - show the Variant (Card Edition), which matches the audit's decision to show Variants.
- **Dragging needs an alternative.** WCAG 2.2 AA (2.5.7, Dragging Movements) requires one, and phones and keyboards need one too. Tap or Enter adds one copy, and the deck's lines have steppers.
- **Library tiles are Card Editions, like Collection (owner, 2026-10-12).** You drag in exactly the version you want. Unowned Editions come from the catalog. TCG Live's variant drawer was tried and dropped. Deck List lines are Card Editions too, and copy limits still count by Identity.
- **Backend gaps:**
  - **Browsing the whole catalog.** `GET /api/catalog/search` requires a name prefix, or a set plus collector number. It can't browse by set or card type, and it doesn't merge ownership in. A library that shows unowned cards needs a browse route with filters and owned counts. Search-first is a fallback.
  - **The owned library.** Collection's per-Edition listing, `GET /api/collection` (the endpoint the audit marked as optional cleanup), already returns one row per Edition with its total. It is a natural source for the owned view, so it shouldn't be removed before this is decided.
  - **Display data.** The earlier gap still applies: not-owned Deck List lines have no display data.

[forum-3829]: https://community.pokemon.com/en-us/discussion/3829/deck-builder-and-card-library-issues
[forum-24855]: https://community.pokemon.com/en-us/discussion/24855/get-acquainted-with-the-enhanced-deck-editor-experience-in-pokemon-tcg-live
[forum-18020]: https://community.pokemon.com/en-us/discussion/18020/how-to-get-specific-cards-tcg-live
[forum-7229]: https://community.pokemon.com/en-us/discussion/7229/how-can-i-use-special-cards-in-tcg-live
[news]: https://www.pokemon.com/us/news/pokemon-tcg-live-landscape-layout-and-deck-editor-updates
[support]: https://support.pokemon.com/hc/en-us/articles/51315704243476-Why-can-t-I-use-my-card-or-deck-in-Pok%C3%A9mon-TCG-Live
[giantbomb]: https://giantbomb.com/wiki/Games/Pokemon_Trading_Card_Game_Online
