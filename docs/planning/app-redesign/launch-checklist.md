# App redesign launch checklist

**Status:** pending. Automated evidence comes from `npm run verify`; nothing here is recorded as done.

The redesign is a launch gate ([spec](spec.md), "Rollout"): PrizeCheck opens to anyone besides the owner only once every page is in the new shell and every walkthrough below is ticked. Each page ticket adds its own walkthrough of 5–10 steps, run on a phone and on a desktop. Code merges to `dev` on the automated checks; these walkthroughs are the owner's own check before launch.

## Implementation evidence

- [ ] Each redesign ticket's acceptance ran the full gate (`npm run verify`) once and quoted the pytest, vitest and Playwright counts from its `verification.log`.
- [ ] Every page passes the shared page check (`web/tests/support/page-check.ts`) at 1280×800 and 375×812, with its dialogs and sheets open as well as closed.

## Release notes

- [ ] `/collection` is the default page, the sign-in landing and the sign-out redirect. `/`, `/workspace` and `/locations` redirect to it, keeping any `?location=` link (#162).
- [ ] The old Collection page is retired. `/old-collection` and its view are gone; an old link to it lands on Collection (#162, #164).
- [ ] Collection shows every Card Edition's Variant Descriptor (or "Unspecified Variant") on tiles, in tile names and in the inspector, and the inspector lists each Storage Leaf that holds the Edition. The Decks page's link reads "Open in Collection" (#164).
- [ ] `GET /auth/session` also returns the signed-in `email`, for the avatar menu (#162).
- [ ] Signing in has its own address, `/sign-in`, which the public header links to. Signed out, an address that is no page shows "Page not found" instead of the sign-in card, and a Published Deck link that no longer works shows "This deck isn't published anymore". Signed in, Discover and Published Decks open inside the app (#163).
- [ ] Owner controls' sub-tabs have their own addresses: Status at `/owner`, then `/owner/catalog`, `/owner/metadata`, `/owner/attributes`, `/owner/reprints`, `/owner/missing` and `/owner/rules` (#167).
- [ ] Owner controls' Catalog, Metadata and Missing cards queues are tables, with each review card opening under its row. A confirmed decision takes its row off the list and shows a message, and the Missing cards queue lists only open reports. The owner-only catalog review routes also return the Printing as recorded and each Edition's Holdings count (#168).
- [ ] Card type has one source, the reviewed card attributes, which gain Trainer Type and evolves from. After migrating to `041_trainer_type_and_evolves_from.sql`, run `scripts/derive_card_attributes.py` once (`docs/operations/release.md`); until then Collection's Trainer Type choices match no card. Collection's Category filter offers "Trainer: any type" and each Trainer Type, and its type filter lists Pokémon only, so a Basic Energy no longer appears under its type (#170).
- [ ] Owner controls' Attributes tab reviews card attributes on the kit: derived, correction and effective values, Correct or Remove correction with a fresh code, and Reject report or Ask for information with a reason only (#170).
- [ ] Owner controls' Reprints tab reviews Reprint Groups on the kit: each Card Identity waiting for review lists its Printings with their regulation mark, Reprint Group and that group's legality, and the owner moves Printings between groups, merges one group into another, or merges one Card Identity into another, each with a reason, evidence and a fresh code. The owner-only Card Identity routes also return each Printing's regulation mark, each group's legality (`as_of` picks the day) and when each queued Printing was created (#171).
- [ ] Collection's Location tree, Manage locations, search, filters and display settings, the stale-collection banner and the Deck heading use the new controls. Filters & display opens as a panel along the right edge of a phone, and Manage locations fills a phone's screen (#166).
- [ ] Opening a Deck on Decks shows it in the deck builder at `/decks/<Deck id>`: the count, the Deck List cost and the cost to complete, and every copy's state in Spread, Stacked and List, grouped by evolution line, Trainer Type and Energy. Pressing the Decks tab returns to the index. Until #181, the old Holdings, Publish and export panels sit under "Holdings, publishing and exports" at the foot of the builder. Every Deck List line in `GET /api/decks/{id}` and in the Deck List command responses carries its card's name, set, collector number, Variant Descriptor, image, card kind, Trainer Type, evolves from and Card Identity, and a Pokémon line also its evolution root and stage, so a deck that skips a stage (Charmander and Charizard ex with no Charmeleon) still forms one evolution line. After migrating to `043_evolution_roots.sql`, run `scripts/derive_card_attributes.py` once (`docs/operations/release.md`); until then a deck that skips a stage shows its Pokémon apart (#176).
- [ ] Catalog is an Edition gallery: one tile per Card Edition, one search box (a printed set code and number such as `PAL 185`, a TCGdex set ID and number such as `sv02 185`, or the start of a name) and one filter row, with no sidebar. Pressing a tile opens the Printing's details and today's report forms until the card popup (#174) replaces them. The gallery loads more cards as you scroll, so My metadata reports moves from the foot of the page to a button beside the page title. A new signed-in route, `GET /api/catalog/editions`, lists Card Editions with their card type, Format Standing in all three Formats and the caller's copies (with `deck_id`, also the copies in that Deck and free elsewhere), 60 to a page; `GET /api/catalog/sets` lists the catalog's sets. Tiles read the printed set code and number ("PAL 185 · Reverse Holo"), from a reviewed table of 136 sets (`api/app/set_codes.tsv`, its sources in its header); a set with no confirmed code shows its TCGdex set ID. Collection's tiles still show the set's name. The gallery lists the newest set first, each set in collector number order; migration `044_catalog_set_release.sql` stores each set's release date at the next catalog import, and until then sets the format rules files don't date come last (`docs/operations/release.md`). `GET /api/catalog/search` stays for its other callers (#173).
- [ ] **Gather N** in the deck builder's header opens the Pick List as a dialog, one row per card, with a source picker on each row and a warning when a source is another Deck that would be left short. Confirm picked and Confirm all each move the copies as one Move with one Undo toast. `POST /api/decks/{id}/pick-list/confirm` now writes one Inventory Undo record per confirmation, however many sources it names, and returns its `undo_id` and `source_count`; the five-source limit (`TOO_MANY_PICK_SOURCES`) is gone, so a Gather no longer pushes Collection's earlier Undo records out. The copy sheet's Gather opens the dialog on that card (#179).
- [ ] Every Deck has one Target Format (Standard, Expanded or Gym Leader Challenge), Standard by default; migrating to `045_deck_list_target_format.sql` makes every existing Deck Standard. The deck builder's second header line holds the "Standard ▾ · ✓ Legal" control: ▾ changes the Target Format, and the result opens a dialog with the "as of" date, the deck and card issues, the rules version and the disclaimer. A card-level issue outlines its lines with a "!". The Deck read, every Deck List command and the format-checks read answer the Target Format's result only (`?format=` still names another), and `PUT /api/decks/{id}/deck-list/target-format` changes it. Publishing and republishing now need a legal result in the Target Format and otherwise answer `409 TARGET_FORMAT_NOT_LEGAL` with the result; snapshots store their Target Format, and snapshots published before read as Standard. Every saved format result is recomputed once on its Deck's next read, because the code that evaluates changed (#178).
- [ ] Copies physically in a Deck but cut from its Deck List show in the deck builder as **Surplus**, in their own group under the Deck List in Spread, Stacked and List; they never count toward N/60. **Put away all**, or pressing one surplus card, moves those copies to a Location you pick as one Move, with an Undo toast. Undo returns the copies to the Deck and, as for any copies arriving in a Deck, puts them back on its Deck List. A warning at the top of the Deck List names the other Decks whose Deck Lists count the same spare copies, and whether each also counts them or holds copies for its own list. Each `surplus` row in `GET /api/decks/{id}` also carries the Deck's Holding `version` and the card's display data (#180).

## Walkthroughs

### The shell (#162)

On a desktop (a window at least 1280 px wide):

- [ ] 1. Sign in. You land on Collection at `/collection`, with the Collection tab marked in the header.
- [ ] 2. Open a Location, search for a card, open Filters and pick a set, change Card size, select two cards and scroll down the gallery. Open Decks, then Collection again: the same Location, search, filter, card size, selection and scroll position are back, with no grey placeholder tiles and no jump in the page's size.
- [ ] 3. Scroll down Collection and check the header (wordmark, tabs, avatar) stays at the top. Press Tab from the top of the page: Skip to main content appears first, then each tab and the avatar show a gold focus ring.
- [ ] 4. Open the avatar menu: it shows your email, Sign-ins, Owner controls and Sign out. Arrow keys move through it, and Escape closes it and returns focus to the avatar. Sign-ins opens a page with your account email.
- [ ] 5. Reload on Collection: it starts at All owned with no search or selection. Open an old `/workspace` or `/locations` bookmark: it opens Collection.

On a phone (iOS Safari or Android Chrome):

- [ ] 6. The bottom tab bar shows Collection, Decks, Catalog and More, each easy to hit with a thumb, and nothing on any page scrolls sideways.
- [ ] 7. Tap ☰ on Collection: Locations opens as a panel along the left edge, with no animation. Choosing a Location closes it; so do the ✕, a tap on the dimmed page and Escape. The browser's back gesture does not close it: it goes back to the previous page, and that page works normally. To check: open Decks, then Collection, open ☰ and go Back; Decks shows, and the tab bar still works.
- [ ] 8. Tap More: a sheet opens along the bottom with Missing cards, Sign-ins, Owner controls and Sign out. Each opens its page or signs you out.
- [ ] 9. On Collection, turn on Select and pick a card: the Actions strip and the Undo message sit above the tab bar, never under it. Switch to Decks and back: the selection and scroll position are kept.

### Sign-in, loading, unavailable and not found (#163)

On a desktop (a window at least 1280 px wide):

- [ ] 1. Sign out from the avatar menu. The page is dark, with the public header (✦ PrizeCheck and Discover decks) above a centred card reading "Sign in to PrizeCheck" and "Know every card you own, and where it is." The terms and privacy line at the bottom of the card is plain text, not a link.
- [ ] 2. Enter your email and press Send code. "If this account can sign in, a code has been sent." appears and a code field shows below. Enter the code and press Sign in: Collection opens.
- [ ] 3. Sign out, then open a bookmark to `/decks`. The card now reads "Sign in to continue where you left off." Sign in: Decks opens.
- [ ] 4. Signed out, open `/discover`. Discover sits under the same header, with Discover decks marked. Sign in at the right of the header opens the sign-in card.
- [ ] 5. Signed out, open `/no-such-page`. It shows "Page not found" and "The link may be mistyped, or the page has moved.", with Discover decks (gold) and Sign in, and each opens what it names. Open `/published/not-a-real-link`: "This deck isn't published anymore" with the same two choices.
- [ ] 6. Signed in, open `/discover` and `/published/not-a-real-link`. Each opens inside the app, with the tabs above and none of them marked, and the unavailable card offers only Discover decks.
- [ ] 7. In the browser's developer tools, set the network to Slow 4G and reload Collection. The dark page shows a muted "✦ PrizeCheck", "Loading…" appears under it only after a moment, and no grey tiles or empty header appear before Collection.

On a phone (iOS Safari or Android Chrome):

- [ ] 8. Sign out. The card fills the width, leaving a small margin on each side, and Discover decks, the email field and both buttons are easy to hit with a thumb. Nothing scrolls sideways. Sign in with a code.
- [ ] 9. Open a mistyped address and `/published/not-a-real-link`. Each card fits the screen, and Discover decks and Sign in are thumb-sized.

### Collection tiles and inspector (#164)

On a desktop (a window at least 1280 px wide):

- [ ] 1. On Collection, turn Names on. Each tile's second line reads set · number · Variant, for example "Paldea Evolved · 185 · Reverse Holo", or "Unspecified Variant". A long Variant ends in "…" and never makes its tile taller than its neighbours. Turn Names off: the line goes.
- [ ] 2. With Names off, rest the pointer on a tile: its tooltip names the Variant too.
- [ ] 3. Select a copy of a card you keep in more than one place. The inspector shows a Variant row under set and number, then "N copies owned" with one line per Storage Leaf (or Deck), such as "2 in Shelf / Binder 2". The lines add up to N.
- [ ] 4. Select or hover a copy and check the selection ring, the check badge, the card art, and the price line with Prices on. They look as they did before this change.
- [ ] 5. On Decks, use "Open in Collection" on a Deck: Collection opens that Deck. An old `/old-collection` bookmark opens Collection.

On a phone (iOS Safari or Android Chrome):

- [ ] 6. Tap a tile. A sheet opens along the bottom, titled with the card's name, showing the Variant row and the line for each Storage Leaf. Close it with ✕, a tap on the dimmed page, or Android's back gesture: you are back on the tile you tapped. On iOS, swiping back leaves Collection and closes the sheet.
- [ ] 7. In Filters & display, turn Names on. Each tile shows its Variant line, cut with "…" when long, and nothing on the page scrolls sideways.
- [ ] 8. Turn on Select and tap a few tiles. Each shows the gold ring and the check badge, and the page still scrolls with a swipe.

### Owner controls (#167)

On a desktop:

- [ ] 1. Open the avatar menu and choose Owner controls. It opens on Status at `/owner`. Above the sub-tabs, a line of pills lists every health check that isn't OK, worst first (a stale backup before a 70% allowance warning, then unverified measurements), or reads "All health checks are OK."
- [ ] 2. The sub-tabs read Status, Catalog, Metadata, Attributes, Reprints, Missing cards and Rules. Each queue tab shows how many items wait; the Catalog count matches Pending catalog reviews in the health table.
- [ ] 3. On Status, the English catalog pull panel shows the last successful pull, the run with its phase and a status pill, a progress bar, and the Enumerated, Fetched and Validated counts. Refresh updates them. Start full pull is disabled while a run is in progress; if a run stops reporting progress, the button reads Restart pull and a warning explains why. Don't start a pull just for this check.
- [ ] 4. Operational health is a table of area, check, value pill and detail. Click into it and use the arrow keys: when it's wider than the window it scrolls sideways inside its own box.
- [ ] 5. Open Rules. Each rule kind is a card with its active version and every version with its digest, the latest marked. Confirm rule change stays disabled until the evidence URL, the reason and a six-digit code are filled in. Activate a rule only if you mean to.
- [ ] 6. Press Tab until a sub-tab is focused, then use the arrow keys: focus moves along the tabs, and Enter opens one, changing the address (for example `/owner/rules`). Reload: the same tab is open. Press Back: the previous tab returns.
- [ ] 7. Reprints lists the Card Identities waiting for a Reprint Group review as a table (#171). Attributes lists its queue as a table (#170). (Catalog, Metadata and Missing cards have their own walkthrough under #168.)

On a phone (iOS Safari or Android Chrome):

- [ ] 8. Open More, then Owner controls. The sub-tab row scrolls sideways inside itself, every tab is easy to hit with a thumb, the health table scrolls sideways inside its own box, and nothing else on the page scrolls sideways.
- [ ] 9. Open Rules: the fields and buttons are thumb-sized, and Send code, the code and Confirm rule change wrap onto new lines instead of running off the screen.

### Owner controls queues (#168)

On a desktop:

- [ ] 1. Open Owner controls, then Catalog. Pending catalog reviews are a table of card, set · number, kind, reports, opened, age and Review. Press Review: the card opens in a row under it with the cursor in Review reason. Press Review on another row: the first card closes, so only one is open. Close folds the card and puts focus back on that row's Review button.
- [ ] 2. On a catalog card, the Incoming change table shows each field as recorded and as incoming, marked "Differs" where they disagree, and the Edition mapping table shows every Edition with its Holdings (copies across every collection). Choose "Deprecate Printing and map every Edition": a Replacement Edition column appears. Don't confirm unless you mean to.
- [ ] 3. Confirm decision stays disabled until Review reason, Review evidence URL and a six-digit code are all filled in. Send code emails you a fresh code.
- [ ] 4. Open Metadata. A card shows source and reviewed values side by side with "Differs" on each changed field, then the linked reports, whose Ask for information and Reject report work once a reason is written. Choosing Correct mapping shows Product ID and Quote variant. Show history unfolds the decision history and Hide history folds it away. With more than 100 targets, Load more adds the next page under the table.
- [ ] 5. Open Missing cards. Begin a record directly is folded above the table and opens its form. A report's card shows the reporter's note, the evidence link and the verified fields, with no review evidence field. Request information and Reject work as soon as a reason is written; Approve shared record also needs a fresh code.
- [ ] 6. Make a decision you need anyway, for example rejecting a duplicate missing-card report. Its row leaves the table, a message at the bottom of the screen says what happened, focus moves to the next row's Review button, and the tab's count drops by one.
- [ ] 7. Request information on a missing-card report: the row stays, marked "needs info", and the message says the reporter was asked.

On a phone (iOS Safari or Android Chrome):

- [ ] 8. Open Owner controls from More, then Catalog, Metadata and Missing cards in turn. Open a card and swipe the table sideways: the card stays at the table's left edge, as wide as the table's box, while the columns move. Nothing else on the page scrolls sideways.
- [ ] 9. On an open card, every field and button is easy to hit with a thumb, and Send code, the code field and the confirm button wrap onto new lines instead of running off the screen.

### Missing cards (#169)

On a desktop:

- [ ] 1. Open the Missing cards tab. It opens on My reports at `/reports`: a table of your reports, newest first, with Card, Kind, Status, Sent and Owner response, or "No reports yet." The line above it says that a wrong detail on a card that exists is reported from the card in Catalog.
- [ ] 2. Open Report a card. With Report type on Missing Printing, the form asks for Set ID, Set name, Collector number and English name, then Evidence link and What is missing?. Switch to Missing Edition: Printing ID and Physical variant details replace the four set fields. Switch back.
- [ ] 3. Type a Set ID, open Decks, then Missing cards again: Report a card is still open, with the Set ID you typed.
- [ ] 4. Finish a test report and press Send private report. "Report sent privately to the owner." appears, My reports opens, and the report is at the top with a Pending pill and today's date. Open Report a card again: the card's fields are still filled in, and Evidence link and What is missing? are empty.
- [ ] 5. In Owner controls, open Missing cards and use Request information, with a reason, on the test report. Back on Missing cards, the report reads Needs information, shows your reason under Owner response, and has a Reply button.
- [ ] 6. Press Reply. A row opens under the report with your note and the owner's question, and the cursor is in Additional information. Type something and press Close: the row folds away, and Reply brings it back with your text. Press Send information: "Information sent to the owner." appears, the pill reads Pending, and Reply is gone. Then reject the test report in Owner controls.

On a phone (iOS Safari or Android Chrome):

- [ ] 7. Open More, then Missing cards. Both sub-tabs are easy to hit with a thumb, the reports table scrolls sideways inside its own box, and nothing else on the page scrolls sideways.
- [ ] 8. On a report that needs information, tap Reply, then swipe the table sideways: the conversation and the reply box stay in place, as wide as the screen, while the columns slide behind them.
- [ ] 9. Open Report a card: each field and Send private report fills the width and is thumb-sized.

### Collection sidebar, Manage locations and filters (#166)

On a desktop (a window at least 1280 px wide):

- [ ] 1. On Collection, the Locations sidebar lists All owned, then your Locations in natural order. Open a folder with its chevron, then open a Storage Leaf: its row is gold and the heading names it. Rest the pointer on a row: a + appears at its right end; Tab onto a row shows the + too.
- [ ] 2. The toolbar keeps Search and Filters on the left and Sort, Card size, Names and Prices on the right, all one height. Open Filters, pick a Set and a Category: the Filters button counts them ("Filters, 2 active") and Clear filters resets only the filters. Names and Prices turn gold while on.
- [ ] 3. Select a card and drag it onto another Storage Leaf in the sidebar: every Leaf it can go to shows a dashed outline, the one under the pointer a solid gold ring, and the drop moves the card with an Undo message.
- [ ] 4. Open Manage locations with the gear. It opens centred, and the page behind doesn't scroll. Drag a Location by its ☰ handle onto another row: valid rows are outlined, the one under the pointer ringed, the rest dimmed. Confirm with Move here. Rename one, and delete an empty one by typing its name. Escape closes the panel and returns focus to the gear.
- [ ] 5. Open a Deck: the heading shows Estimated Deck Cost and Export. Export opens a menu (arrow keys move through it); Pokémon TCG Live opens its panel, and Escape returns focus to Export.
- [ ] 6. Change something in another tab (add or move a card). Back here, a slim banner reads "Your collection changed in another tab or session." with Reload; Reload brings the change in.

On a phone (iOS Safari or Android Chrome):

- [ ] 7. The header shows ☰, Collection, Search and Filters & display, all thumb-sized, and nothing scrolls sideways. Filters & display opens along the right edge; a change applies at once, and a tap on the dimmed page closes it.
- [ ] 8. Tap ☰: each Location row and its + are thumb-sized. Tap the gear: Manage locations fills the screen. Drag a Location by its ☰ handle onto another row with your finger, or tap the handle to choose from a list. Close it: you are back on ☰.
- [ ] 9. Open a Deck and tap Export, then TCGplayer Mass Entry: the panel fills the screen and its buttons are thumb-sized. Tap Add cards in a Storage Leaf: the panel opens along the bottom, and its fields and buttons are thumb-sized.

### Deck builder: the Deck List (#176)

On a desktop (a window at least 1280 px wide):

- [ ] 1. On Decks, press a Deck's name. The address ends in `/decks/` and the Deck's id, the Deck's name is the page title, and All Decks leads back. The Deck List fills the left, and a Library column on the right says adding cards comes in the next update.
- [ ] 2. The first header line reads N/60, then "$… deck (P/T priced) · $… to complete (P/T priced)". The cost to complete counts only the copies you don't own anywhere.
- [ ] 3. Spread is selected. Every copy is its own card: solid for a copy in this Deck, a dashed outline with ↻ for a copy you own somewhere else, faded with $ for a copy you don't own. Rest the pointer on a dashed copy: its tooltip names the Location (or "(Deck)" after another Deck's name).
- [ ] 4. Lines are grouped: each evolution line ("Charizard ex line", even when the deck skips Charmeleon) with its first stage first, then Other Pokémon, Supporters, Items, Tools, Stadiums, Other Trainers (a Trainer whose type isn't known yet) and Energy. Each heading shows its card count, and the counts add up to N.
- [ ] 5. Press a copy. A dialog names the card, its set, number and Variant and what kind of card it is, says what this copy is, and splits the line's copies between this Deck, each other Location and not owned. Escape closes it and puts focus back on the copy.
- [ ] 6. Choose Stacked: one pile per Edition with a summary such as "×4 1↻ 1$". Press the right arrow key on the switch: List is chosen, with each line's quantity, Edition, ownership counts and the price of that many copies (a dash when there is no price).
- [ ] 7. Open "Holdings, publishing and exports" at the foot of the page: the old panels work as before. Move a copy out of the Deck there, then look at the Deck List above: that copy now shows as owned elsewhere.

On a phone (iOS Safari or Android Chrome):

- [ ] 8. Open a Deck. Library and Deck tabs sit at the top, with Library chosen and the Deck tab reading "Deck N/60". Tap Deck: the Deck List opens in Stacked, every pile and button is easy to hit with a thumb, and nothing scrolls sideways.
- [ ] 9. Tap a pile: its sheet opens along the bottom; close it with ✕ or a tap on the dimmed page. Choose Spread, then List: nothing scrolls sideways, and long card names end in "…".

### Catalog: the Edition gallery (#173)

On a desktop (a window at least 1280 px wide):

- [ ] 1. Open the Catalog tab. Under the title sit the search box, a hint under it, one row of chips and a status line reading "N Printings · English catalog from TCGdex, last pulled …". There is no sidebar. The gallery shows one tile per Card Edition with its set · number · Variant, a price line, and "×N" on the cards you own; the cards you don't own are darker. The newest set comes first, its cards in collector number order (2 before 10).
- [ ] 2. Type `PAL 185` (or the code and number printed at the bottom left of a card you own): the hint reads "Set and number: Paldea Evolved (PAL) number 185." and the gallery shows that card's Editions, each tile reading "PAL 185 · …". `pal 185` and `sv02 185` find the same card. Open `api/app/set_codes.tsv` and check a few codes against your cards. Type the start of a name such as `pika`: the hint reads "Name: cards whose name starts with “pika”." Clear the box.
- [ ] 3. Press Standard: cards not legal in Standard leave the gallery, and a card whose legality isn't known yet stays with a "?" in its corner. Press Any format, then Supporter: only Supporters remain. Press Supporter again to clear it.
- [ ] 4. Press Any set: a dialog lists every set A–Z with its printed code (or TCGdex ID) and card count. Type part of a set's name and choose it: the chip reads "Set: …" and the gallery lists that set in collector number order. Press Owned only: only cards you own remain.
- [ ] 5. Scroll down: more tiles join the gallery before you reach its end, with no button to press, and after the last card it reads "All N cards shown" (try a search with a few hundred results). Open Collection, then Catalog again: the search, the chips, the loaded tiles and the scroll position are as you left them.
- [ ] 6. Press a tile: a dialog shows the card's art, set and number, Card Identity, source, and each Edition with its price and Report metadata. Escape closes it and puts focus back on the tile. My metadata reports opens from the button at the right of the page title.

On a phone (iOS Safari or Android Chrome):

- [ ] 7. Open Catalog. The search box fills the width and is thumb-sized. Swipe the chip row: it scrolls sideways inside itself and fades at its right edge, every chip is easy to hit, and nothing else on the page scrolls sideways.
- [ ] 8. Tap Any set: the set list opens along the bottom. Close it, then tap a tile: its details open along the bottom, and ✕ or a tap on the dimmed page closes them.

### Deck builder: Gather (#179)

On a desktop (a window at least 1280 px wide):

- [ ] 1. Open a Deck whose Deck List has copies you own in other Locations. The first header line ends in **Gather N**, where N counts those copies. With every owned copy already in the Deck, it reads Gather 0 and can't be pressed.
- [ ] 2. Press Gather N. A dialog titled "Gather cards you own" lists one row per card: its name, set, number and Variant, a source picker, how many copies come from where, and a line saying how many copies from how many Locations in all.
- [ ] 3. On a card spread over several Locations, the picker starts on "Suggested: N Locations". Choose one Location: the row now takes copies from there only (no more than it holds).
- [ ] 4. A row whose copies come from another Deck that lists them for itself says "Leaves <Deck> (Deck) N short".
- [ ] 5. Tick one row and press Confirm 1 picked. The dialog closes, a toast says "Moved N copies from N Locations into <Deck>." with Undo, and the copies show solid in the Deck List.
- [ ] 6. Press Gather again, then Confirm all on a list that draws on more than five Locations. One toast names them all. Press Undo once: every copy goes back to where it came from, and the toast says how many Locations got copies back.
- [ ] 7. Press a dashed (↻) copy, then Gather in its sheet. The Pick List opens with that card's row already ticked and focused.

On a phone (iOS Safari or Android Chrome):

- [ ] 8. On the Deck tab, tap Gather N. The dialog fills the screen; the checkboxes, pickers and buttons are easy to hit with a thumb, and nothing scrolls sideways. Confirm all, then tap Undo in the toast above the tab bar.

### Deck builder: Target Format (#178)

On a desktop (a window at least 1280 px wide):

- [ ] 1. Open a Deck you built before this update. Under the count and the cost, the second line starts with "Standard ▾ · " and the result: "✓ Legal", "✕ Not legal" or "? Unknown".
- [ ] 2. Press the result. A dialog titled "Standard result" shows the result as of today, the deck issues and the card issues with plain reasons (each card issue names its cards), the rules version and the advisory disclaimer. Escape closes it and puts focus back on the result.
- [ ] 3. Open the result again and pick a date a few months ahead in As of: a note says the date is in the future and later rule changes are unknown. Close the dialog: the header still shows today's result.
- [ ] 4. Choose Gym Leader Challenge with ▾. The result changes (a deck with four copies of a card turns "✕ Not legal"), and those cards' copies get an outline and a "!". Reload: Gym Leader Challenge is still chosen.
- [ ] 5. Choose Standard again. If the deck is not legal in Standard, open "Holdings, publishing and exports" and try Publish: it says publishing needs a legal result in the Target Format, and nothing is published.
- [ ] 6. With a legal Deck, Publish works, and the public page's address answers as before.
- [ ] 7. Add cards until the Deck List passes 60 (from "Holdings, publishing and exports"): nothing stops you, the count reads over 60, and the result says the deck has more than 60 cards.

On a phone (iOS Safari or Android Chrome):

- [ ] 8. Open a Deck and tap the Deck tab. Tap ▾: the phone's own picker lists Standard, Expanded and Gym Leader Challenge. Pick one: the result follows, both parts are easy to hit with a thumb, and nothing scrolls sideways.
- [ ] 9. Tap the result: it opens as a sheet along the bottom with the same contents; close it with ✕.

### Deck builder: Surplus and the competition warning (#180)

On a desktop (a window at least 1280 px wide):

- [ ] 1. In a Deck that holds cards, remove a card from its Deck List, or lower a line below the copies the Deck holds (the deck builder's editing, #177). Removing never moves cards: a **Surplus** group with its card count appears under the Deck List, and N/60 doesn't count it.
- [ ] 2. In Spread, every surplus copy is its own card; in Stacked, one pile per card with "×N"; in List, one row per card. Rest the pointer on one: its tooltip says it's in this Deck but not on the Deck List.
- [ ] 3. Press one surplus card. A dialog "Put away N copies" offers your Locations for that card's copies only. Press Escape: it closes and focus returns to the card.
- [ ] 4. Press **Put away all**, choose a Storage Leaf and press "Put away N copies". The dialog closes, the Surplus group goes, and a toast says "Put away N copies to <Location>." with Undo. Open that Location in Collection: the copies are there.
- [ ] 5. Back in the Deck, press Undo (within ten minutes, before any other Collection action). The copies return to the Deck, and the toast says they're on its Deck List again: N/60 rises by that many.
- [ ] 6. Plan a card in two Decks that neither holds, with fewer spare copies elsewhere than they need together. Open either Deck: a warning at the top of the Deck List names the card, says how many copies are counted as owned elsewhere and how many are spare, and names the other Deck.

On a phone (iOS Safari or Android Chrome):

- [ ] 7. Open the Deck tab of a Deck with surplus. The warning and the Surplus group fit the screen with nothing scrolling sideways, and every surplus pile and Put away all is easy to hit with a thumb.
- [ ] 8. Put away all from the bottom sheet, switch to Library and back to Deck: the toast is still there, and Undo still works.

## Manual checks that automation does not cover

- [ ] Real touch on iOS Safari and Android Chrome for the tab bar, the More sheet and the ☰ drawer (the browser tests only emulate touch), including the home indicator area under the tab bar.
- [ ] Screen reader walkthrough (VoiceOver on macOS and iOS, NVDA on Windows): the tabs announce the current page, the avatar menu announces as a menu, and the drawer and sheet announce their titles and return focus when they close.
- [ ] Safari and Firefox on desktop: the avatar menu, the sticky header and the dialogs (the browser tests run in Chromium only).
- [ ] Screen reader on the sign-in card: the heading and subtitle are read first, the Email and Six-digit code fields are named, and "a code has been sent" is announced. On a slow load, "Loading…" is announced once (#163).
- [ ] Until the dark first paint (rollout stage 7), a slow first load still shows a brief light page before the dark loading screen. That is expected for now (#163).
- [ ] Screen reader on Collection: with Names off, a tile is read with its Variant (or "Unspecified Variant"), and the inspector's Leaf list is read as a list (#164).
- [ ] Screen reader on Owner controls: the sub-tabs announce as tabs with their counts and which one is selected, the problems line reads as a list, and the health table reads as a table with its column headers (#167).
- [ ] Screen reader on the Owner controls queues: each Review button is read with its card and whether it is expanded, an open card is read as an article named for its card with the cursor in Review reason, and the message after a decision is announced once (#168).
- [ ] Screen reader on Missing cards: the sub-tabs announce as tabs and which one is selected, the reports table reads with its column headers, Reply announces whether its row is open, and after a send the message is read where focus lands (#169).
- [ ] Real touch and Safari on Collection: Manage locations' handle drag with a finger on iOS Safari and Android Chrome, and the sidebar's tile drag and the + on hover in Safari and Firefox on desktop (#166).
- [ ] Screen reader on the deck builder: each copy is read with its card, Edition, copy number and state (and the Location of a copy owned elsewhere), a Stacked pile with its counts, Spread / Stacked / List as a radio group, and on a phone Library and Deck as tabs with the Deck count (#176).
- [ ] Screen reader on Catalog: the search box is read with its hint, each chip with whether it is pressed, the set chip as opening a dialog, and each tile with its card, set and number, Variant, how many you own and, under a format chip, "legality unknown" for a "?" card (#173).
- [ ] Screen reader on the Target Format control: the picker is read as "Target Format" with the chosen Format, the result as a button with its status and issue count, a change announces the new result once, and a highlighted copy is described as having a format issue (#178).

## Sources

The [app redesign spec](spec.md), the [app shell resolution](wayfinder/resolutions/decide-app-shell.md), the [component kit resolution](wayfinder/resolutions/decide-component-kit.md) and the [rollout resolution](wayfinder/resolutions/decide-rollout-and-verification.md).
