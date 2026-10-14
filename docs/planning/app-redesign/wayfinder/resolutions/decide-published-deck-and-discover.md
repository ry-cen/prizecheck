# Resolution — Published Deck and Discover pages

**Owner confirmed:** 2026-10-12, by grilling

**Ticket:** [Decide the Published Deck and Discover pages](https://github.com/ry-cen/prizecheck/issues/127)

**Also decided here:** the **Target Format** and the publishing gate. They are recorded in [ADR 0011](../../../../adr/0011-publishing-needs-a-legal-target-format.md) and `CONTEXT.md`, and they amend [the Deck experience resolution](decide-deck-experience.md).

## Decision

### Shell

- **Signed out:** Published Deck and Discover use the slim public header, with **Discover** and **Sign in**.
- **Signed in:** they open inside the full app shell, with tabs and the avatar menu.
- Discover is not a tab. It is reached from the Decks page and from the public header.

### Published Deck page (`/published/:token`)

- **Page header:**
  - the title, then "The card list is a snapshot from [date]; format results update automatically";
  - the deck's **Target Format result**, as a pill that opens the results dialog (issues with reasons, rules version, disclaimer). The Target Format is frozen with the snapshot, and its result follows rotations and bans;
  - the deck total and how many copies have a price;
  - **Copy for TCG Live** (primary; any Live blockers show in its dialog), **Buy on TCGplayer** (Mass Entry for the whole list) and **Share** (copy link).
- **Cards:** the deck builder's deck panel, **read-only**.
  - Spread, Stacked and List views, with the builder's defaults (Spread on desktop, Stacked on phones) and the switch kept.
  - Every copy is a plain tile with no ownership marks and no key.
  - A card-level issue highlights its tiles.
- **Prices:**
  - Spread and Stacked tiles show the price of one card.
  - List lines show the price for that many copies ("4 Iono PAL 185 · Normal · $4.40"), as Limitless does.
  - The card popup shows the price of one card.
  - **No price age is shown or sent.**
- **Card popup:** read-only. It shows art, Edition (set, number, Variant), price and the Target Format legality, with ‹ › to step through the deck. There's no ±1, Swap or Gather.
- **The old four-copy check list is dropped.** The format result covers copy limits and deck size.
- **Owner bar** (only for the signed-in owner):
  - "Your Published Deck · Unlisted · v3", with Make Listed or Unlisted, Revoke and **Open Deck**;
  - "Deck deleted" for an orphan (Open Deck is absent);
  - "Hidden from Discover: not legal in Standard" while the snapshot isn't legal.
  - **Republish** is managed from the Deck.
- **Managing publications:** the Decks index's **Published Decks** section is confirmed as where publications are managed, orphans included.

### Discover page (`/discover`)

- **Results:** a grid of deck cards, newest first. Each card shows a featured card, the title, the card count, a ✓ **Target Format** pill, the published date, and the **deck cost from cached prices only**.
  - Discover never starts a price refresh.
  - A card without a cached price leaves a visible gap in the cost.
- **Filters:** a search box (title or card name), and **format chips (Any, Standard, Expanded, GLC) that filter by Target Format**.
- **Listing:** only Listed Published Decks whose snapshot is **legal in its Target Format right now**. A deck that stops being legal leaves Discover and comes back automatically.

### Target Format and the publishing gate (see ADR 0011)

- Every Deck has one Target Format. It is Standard unless chosen otherwise, existing Decks become Standard, and it can be changed at any time.
- A Deck shows only its Target Format's result. Changing the Target Format is how you check another format.
- **Publishing and republishing need a `legal` result.** `not_legal` and `unknown` both block. Editing and moving cards are never blocked.
- **Deck builder (amends [the Deck experience resolution](decide-deck-experience.md)):**
  - The three format pills become **one control, "Standard ▾ · ✓ Legal"**. ▾ changes the Target Format, and the result opens the dialog.
  - The library's format chip **starts on the Target Format**.
  - **Publish is disabled** while the result isn't legal, with the reason: "Publish needs a legal Standard deck: 2 issues".
  - The Decks index shows **one format pill** per Deck.

### Privacy

**No public route may serve ownership or storage data**, not merely leave it undisplayed. That covers today's public routes and every new public field: per-Edition prices, Target Format and results in Discover summaries, and the snapshot's Target Format. Public pages are built only from the frozen snapshot, catalog facts, prices and format results.

## What the spec and backend need

- **Deck:** a Target Format field (Standard by default, existing Decks migrated). Its format check reads the Target Format only.
- **Publishing:** the publish and republish commands refuse a Deck List whose Target Format result isn't `legal`. Snapshots store their Target Format.
- **Public Published Deck format results:** for the snapshot's Target Format.
- **Public cost response:** extended with **each Edition's price** (amount only, no age), through the existing price cache and admission caps. No new route.
- **Discover:**
  - summaries carry the Target Format and its current result;
  - listing excludes snapshots that aren't legal now;
  - a Target Format filter;
  - a **cached-only deck cost** that never admits a refresh.
- **Spec wording:** the [Deck Lists and format validation spec](../../../deck-format-validation/spec.md) still says results never block publishing and that all three formats are checked together. The app redesign spec takes over from it here.

## Later (out of scope for this map)

**Minimum Deck Cost:** what a deck would cost with every card in its cheapest playable version. The likely definition is "the cheapest Card Edition in each card's Reprint Group that is legal in the Target Format". The owner asked for it to be saved for later.
