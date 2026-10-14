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
- [ ] The avatar menu shows the signed-in email, with the provider's name and picture when there is one, from `GET /auth/session` as the OAuth sign-in already returns it (#162).
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
- [ ] Every Deck has one Target Format (Standard, Expanded or Gym Leader Challenge), Standard by default; migrating to `045_deck_list_target_format.sql` makes every existing Deck Standard. The deck builder's second header line holds the "Standard ▾ · ✓ Legal" control: ▾ opens a menu of the three Formats (the app's own menu, not the browser's picker, on every device) that changes the Target Format, and the result opens a dialog with the "as of" date, the deck and card issues, the rules version and the disclaimer. A card-level issue outlines its lines with a "!". The Deck read, every Deck List command and the format-checks read answer the Target Format's result only (`?format=` still names another), and `PUT /api/decks/{id}/deck-list/target-format` changes it. Publishing and republishing now need a legal result in the Target Format and otherwise answer `409 TARGET_FORMAT_NOT_LEGAL` with the result; snapshots store their Target Format, and snapshots published before read as Standard. Every saved format result is recomputed once on its Deck's next read, because the code that evaluates changed (#178).
- [ ] Copies physically in a Deck but cut from its Deck List show in the deck builder as **Surplus**, in their own group under the Deck List in Spread, Stacked and List; they never count toward N/60. **Put away all**, or pressing one surplus card, moves those copies to a Location you pick as one Move, with an Undo toast. Undo returns the copies to the Deck as surplus and leaves its Deck List as it is (Deck List Undo and inventory Undo never undo each other); other copies arriving in a Deck still join its Deck List. The commit command takes `put_away: true` for this Move, accepted only for a Move out of one Deck (`422 PUT_AWAY_NEEDS_ONE_DECK` otherwise), and migration `047_put_away_undo_returns_surplus.sql` marks its Undo record; during process overlap or after a rollback, the previous release's Undo of a Put away lists the copies again, as before (`docs/operations/release.md`). A warning at the top of the Deck List names the other Decks whose Deck Lists count the same spare copies, and whether each also counts them or holds copies for its own list. Each `surplus` row in `GET /api/decks/{id}` also carries the Deck's Holding `version` and the card's display data (#180).
- [ ] Pressing a Catalog tile opens the card popup: the art, the set with its printed code and number, the regulation mark, the Card Identity when it differs from the name, the source, a legality pill per Format (with the reason for an unknown one), the Editions with copies owned, price and Owner reviewed or Unavailable badges, and where your copies are. "‹ N / M ›" and the ← → keys step through the gallery. **Add N** puts copies of the chosen Edition in a Storage Leaf (as a batch add with an Undo toast since #175), and **Plan 1** adds one copy to a Deck's Deck List without moving a card. The footer opens today's report forms. My metadata reports stays beside the page title, because the gallery scrolls on. `GET /api/catalog/editions` gains a `printing_id` filter (one Printing's Editions) and a `regulation_mark` on every row (#174).
- [ ] Discover (`/discover`) is on the new design and lists only Listed Published Decks that are legal in their Target Format today: a deck that stops being legal (a rotation, a ban, a corrected card) leaves Discover and returns once legal again, without republishing. It shows a grid of deck cards, newest first, each with a featured card, the title, a ✓ Target Format pill, the card count, the published date and the cost from cached prices: "$142", "$118+" (some cards not priced yet) or "Price on page". A search box (title or card name) and the Any, Standard, Expanded and GLC chips filter it. `GET /api/public/discovery` gains `format=` and each summary gains `featured_name`, `target_format`, `target_format_status` and `cost: {amount, priced_copies, total_copies}`; its cursors change, so a "More decks" press across the release restarts at page one. Snapshots published before rows carried references (legacy rows) and decks whose public format records predate migration 038 stay out of Discover until they are republished or `scripts/backfill_public_catalog.py` runs. The sitemap is unchanged (#182).
- [ ] The Decks page is on the new look. It lists every Deck with how many of its Deck List's cards it holds ("41/60 in Deck", or "Empty: plan a list"), its cost to complete and its Target Format result, and has a **Published Decks** section listing every publication (those whose Deck was deleted included) with Make Listed or Unlisted and a two-step Revoke, and a "Discover decks" link. `GET /api/decks` rows also carry `deck_list_total`, `in_deck` and `target_format`. The deck builder's header holds **Export** (one dialog for Pokémon TCG Live and TCGplayer Mass Entry), **Publish** and **Delete**, and its first line **Buy missing**, which opens the Mass Entry export on the cards you don't own with the whole Deck List as the other choice; the old "Holdings, publishing and exports" panels are gone. Publish is disabled while the Target Format result isn't legal and says why ("Publish needs a legal Standard deck: 2 issues"); a published Deck shows "Published · vN" and opens the publication's title, visibility and version with Republish, List in Discover or Make Unlisted, and Revoke. Publishing and republishing start a background price refresh for the snapshot's cards within the existing limits, so a fresh listing is usually priced; it never forces a refresh of prices checked in the last hour. Delete asks for the Deck's name, moves its cards to Unsorted and leaves any Published Deck live. In Collection an open Deck keeps its cards with Move, Remove and Undo under a banner with its cost, its Deck List cost and cost to complete, and "Open in the deck builder"; Collection's Deck export menu and the Decks page's "Open in Collection" links are gone. The web client's Mass Entry export now defaults to the cards not owned, as the API always has. No migration (#181).
- [ ] The deck builder edits the Deck List. Its right-hand column (on a phone the Library tab, chosen first) is the **library**: one tile per Card Edition, reading copies free (owned, not in this Deck) of copies owned and the price, with Owned / All (starting on Owned, unowned cards darkened), a search box, format chips starting on the Deck's Target Format (a "?" marks a card of unknown standing) and type chips. It scrolls on its own beside the Deck List. Drag a tile onto the Deck List (mouse or pen) to add one copy, or tap it for the card popup with −1 / N on Deck List / +1 and ‹ › stepping. A copy's sheet has ±1 and **Swap this copy for** another Edition of the same Card Identity; dragging a copy onto the library, or Delete or Backspace on it, takes it off. Every add, remove or swap is one batch with an Undo toast, repeated inside an open popup or sheet; an Undo after the Deck List changed says "Can't undo: this deck changed." Fast taps all count: they wait behind the change on its way and go as one batch. Adding never moves a card, and Deck List Undo and Collection's Undo never undo each other. New route `POST /api/decks/{id}/deck-list/changes` takes `revision`, `idempotency_key` and `changes: [{edition_id, quantity}]` (each the line's new total, 0 removing it), applies them atomically with one revision and answers the usual Deck List command result; the per-line routes stay, and Catalog's Plan 1 now uses the batch route. `GET /api/catalog/editions` gains an `identity_id` filter; browse cursors from before the release restart once. No migration (#177).
- [ ] Catalog's page header has a **Browse / Add to a Location** switch. In Add mode a bar stays at the top while you scroll: "Adding to" a Location you pick, the cards you queued, **Clear** and **Add N cards** (on a phone, Clear and Add appear once something is queued). Every tile gets a **+** that becomes − N +, and queued tiles are outlined; the queue survives new searches and filters. Add N cards adds the whole queue to the Location at once, with one Undo toast that takes exactly those copies out again. The card popup's Add row starts on that Location, and its Add N is a batch add with an Undo too. Collection's **Add cards** now opens the same gallery in Add mode over Collection (filling a phone's screen): from a Location it is set to that Location, from All owned it asks for one, and Add N cards closes it and leaves you in that Location with an Undo toast. The old Add cards dialog and its search are gone from Collection. A new route, `POST /api/holdings/batch`, adds up to 200 Card Editions to one Location in one transaction with one owner revision, replays by its idempotency key, and writes one Inventory Undo record of a new `add` kind; undoing it answers `UNDO_INCOMPATIBLE` once one of those copies has left the Location. The newest-only rule and the five-record limit are unchanged. Migration `046_inventory_undo_add.sql` allows the new kind; during process overlap or after a rollback, the previous release lists `add` records, refuses to undo them (`UNDO_INCOMPATIBLE`) and can dismiss them. Add cards on an open Deck adds physical copies to it and extends its Deck List; Undo takes the copies out but keeps the Deck List lines, as after any Move out of a Deck (#175).
- [ ] A Published Deck (`/published/<token>`) is on the new design, under the public header or inside the app. Its header shows the title, "The card list is a snapshot from <date>; format results update automatically", the Target Format result as a pill that opens the results dialog, the card count with the total price and how many copies are priced, and **Copy for TCG Live**, **Buy on TCGplayer** (Mass Entry for the whole list) and **Share** (copies the link). The cards show in Spread, Stacked or List like the deck builder's, grouped by evolution line, Trainer Type and Energy, with no ownership marks: tiles show one card's price and List lines the price of that many copies, and a card with a format issue is outlined with a "!". Pressing a card opens a read-only card popup with its Edition, price and legality, stepping through the deck. The old four-copy check list and the price-age notes are gone. Signed in, the deck's owner gets a bar with its visibility and version, Make Listed or Unlisted, Revoke and Open Deck ("Deck deleted" once the Deck is gone), and "Hidden from Discover: not legal in Standard" while a Listed snapshot isn't legal. `GET /api/public/decks/{token}/versions/{version}/format-checks` now answers only the snapshot's Target Format and no longer takes `format=`; the public cost gains `editions: [{edition_ref, amount}]` (each Edition's price, no age) and drops `stale_copies` and `unknown_age_copies` (no price age is sent); and new snapshots freeze each row's card kind, Trainer Type, evolves from and evolution root and stage. A snapshot published before this release shows its cards in one "Cards" group until it is republished. Revoke snapshots published on this release before rolling back past it (`docs/public-projections.md`). No migration (#183).
- [ ] The old light stylesheet is gone and Tailwind's Preflight is on, so every page draws only the kit's look; nothing is meant to look different. The app is dark from the very first paint: the HTML page itself is dark, with `color-scheme` and `theme-color` meta tags and a quiet "✦ PrizeCheck" in the middle until the app replaces it, so a slow load no longer flashes white. The page's dark background now reaches `<html>` on every page, not only on Collection and the signed-out screens (#184).
- [ ] With the OAuth sign-in on the redesign: "Back to Sign-ins" on the Sign-ins page moves focus to the page's heading; a provider button's `next` never carries a failure's `error`, `error_description` or `provider`, so a failure isn't shown again after signing in; and the avatar shows a provider picture only from an `https://` address (#184).

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
- [ ] 2. Press Continue with Google (or Continue with Discord) and finish with the provider: Collection opens. Sign out again, cancel at the provider instead, and come back: the card says "Sign-in was cancelled." above the buttons, and the address bar no longer shows the error.
- [ ] 3. Sign out, then open a bookmark to `/decks`. The card now reads "Sign in to continue where you left off." Sign in: Decks opens.
- [ ] 4. Signed out, open `/discover`. Discover sits under the same header, with Discover decks marked. Sign in at the right of the header opens the sign-in card.
- [ ] 5. Signed out, open `/no-such-page`. It shows "Page not found" and "The link may be mistyped, or the page has moved.", with Discover decks (gold) and Sign in, and each opens what it names. Open `/published/not-a-real-link`: "This deck isn't published anymore" with the same two choices.
- [ ] 6. Signed in, open `/discover` and `/published/not-a-real-link`. Each opens inside the app, with the tabs above and none of them marked, and the unavailable card offers only Discover decks.
- [ ] 7. In the browser's developer tools, set the network to Slow 4G and reload Collection. The dark page shows a muted "✦ PrizeCheck", "Loading…" appears under it only after a moment, and no grey tiles or empty header appear before Collection.

On a phone (iOS Safari or Android Chrome):

- [ ] 8. Sign out. The card fills the width, leaving a small margin on each side, and Discover decks and both provider buttons are easy to hit with a thumb. Nothing scrolls sideways. Sign in with Google or Discord.
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
- [ ] 6. Press a tile: the card popup opens (its own walkthrough is under #174). Escape closes it and puts focus back on the tile. My metadata reports opens from the button at the right of the page title.

On a phone (iOS Safari or Android Chrome):

- [ ] 7. Open Catalog. The search box fills the width and is thumb-sized. Swipe the chip row: it scrolls sideways inside itself and fades at its right edge, every chip is easy to hit, and nothing else on the page scrolls sideways.
- [ ] 8. Tap Any set: the set list opens along the bottom. Close it, then tap a tile: its card popup opens along the bottom, and ✕ or a tap on the dimmed page closes it.

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
- [ ] 4. Press ▾: a menu lists Standard, Expanded and Gym Leader Challenge, with a check mark on Standard. Press Escape: it closes and focus is back on ▾. Press ArrowDown, then End and Enter, to choose Gym Leader Challenge from the keyboard. The result changes (a deck with four copies of a card turns "✕ Not legal"), and those cards' copies get an outline and a "!". Reload: Gym Leader Challenge is still chosen.
- [ ] 5. Choose Standard again. If the deck is not legal in Standard, Publish in the page header is disabled and says publishing needs a legal Standard deck (since #181).
- [ ] 6. With a legal Deck, Publish works, and the public page's address answers as before.
- [ ] 7. Add cards until the Deck List passes 60 (in Collection, with the Deck open; since #181): nothing stops you, the count reads over 60, and the result says the deck has more than 60 cards.

On a phone (iOS Safari or Android Chrome):

- [ ] 8. Open a Deck and tap the Deck tab. Tap ▾: the app's menu opens below it, inside the screen, listing Standard, Expanded and Gym Leader Challenge, each easy to hit with a thumb. Pick one: the menu closes, the result follows, both parts of the control are easy to hit, and nothing scrolls sideways. A tap outside the menu closes it without changing anything.
- [ ] 9. Tap the result: it opens as a sheet along the bottom with the same contents; close it with ✕.

### Deck builder: Surplus and the competition warning (#180)

On a desktop (a window at least 1280 px wide):

- [ ] 1. In a Deck that holds cards, remove a card from its Deck List, or lower a line below the copies the Deck holds (the deck builder's editing, #177). Removing never moves cards: a **Surplus** group with its card count appears under the Deck List, and N/60 doesn't count it.
- [ ] 2. In Spread, every surplus copy is its own card; in Stacked, one pile per card with "×N"; in List, one row per card. Rest the pointer on one: its tooltip says it's in this Deck but not on the Deck List.
- [ ] 3. Press one surplus card. A dialog "Put away N copies" offers your Locations for that card's copies only. Press Escape: it closes and focus returns to the card.
- [ ] 4. Press **Put away all**, choose a Storage Leaf and press "Put away N copies". The dialog closes, the Surplus group goes, and a toast says "Put away N copies to <Location>." with Undo.
- [ ] 5. Press Undo (within ten minutes, before any other Collection action). The copies return to the Deck as surplus: the toast says they're surplus again, not on its Deck List, the Surplus group is back with the same count, and N/60 doesn't change. Put them away again and open that Location in Collection: the copies are there.
- [ ] 6. Plan a card in two Decks that neither holds, with fewer spare copies elsewhere than they need together. Open either Deck: a warning at the top of the Deck List names the card, says how many copies are counted as owned elsewhere and how many are spare, and names the other Deck.

On a phone (iOS Safari or Android Chrome):

- [ ] 7. Open the Deck tab of a Deck with surplus. The warning and the Surplus group fit the screen with nothing scrolling sideways, and every surplus pile and Put away all is easy to hit with a thumb.
- [ ] 8. Put away all from the bottom sheet, switch to Library and back to Deck: the toast is still there, and Undo still works.

### Catalog: the card popup (#174)

On a desktop (a window at least 1280 px wide):

- [ ] 1. Open Catalog and press the tile of a card you own. The card popup opens over the page: the art, with "Artwork belongs to the Printing and does not prove an Edition finish." under it, and beside it the set name with its printed code and number, the regulation mark and the source ("TCGdex", or "Owner reviewed manual record" with its evidence). A card whose name has a subtitle, such as "Professor's Research (Professor Juniper)", also reads "Card Identity: Professor's Research"; other cards don't.
- [ ] 2. Under Legality, one pill per Format reads Legal, Not legal or Unknown. Under an Unknown one, a line says why. A card from a set released in the last few days shows one.
- [ ] 3. Under Editions, each Edition shows its Variant, how many you own and its price; a retired Edition comes last and reads "Unavailable". Press another Edition: the line under the list gives its full price, and "Where your copies are" lists each Location that holds it, with how many.
- [ ] 4. Beside ✕ it reads "N / M". Press › and ‹, then the → and ← keys: the popup steps through the gallery's cards in order, and keeps going past the cards loaded so far. Press Escape: focus lands on the tile of the card the popup showed last.
- [ ] 5. In the Collection row, choose a Location, press + twice and press Add 3. The popup says where the copies went, and the counts under Editions and "Where your copies are" go up. Close it: the tile shows the new "×N". Scroll on: the gallery doesn't jump back to the top and doesn't say "Your collection changed".
- [ ] 6. In the Deck List row, choose a Deck and press Plan 1 twice. The popup says the Deck List now has 2 of this Edition. Open that Deck on Decks: the card is on its Deck List, and no card moved into the Deck.
- [ ] 7. In the footer, press "this Edition", "Printing metadata" and "a missing Edition" in turn: each opens today's report form under the footer, one at a time, with the cursor in its first field. Press the open one again to close it.

On a phone (iOS Safari or Android Chrome):

- [ ] 8. Tap a tile: the popup rises from the bottom of the screen as a sheet. Every button, picker and link in it is easy to hit with a thumb, nothing scrolls sideways, and ✕ or a tap on the dimmed page closes it.

### Discover (#182)

On a desktop (a window at least 1280 px wide), signed out:

- [ ] 1. Open `/discover` from the public header's "Discover decks". The page title is "Discover decks", with a search box and the Any, Standard, Expanded and GLC chips under it, and a grid of deck cards, newest first.
- [ ] 2. Each card shows a featured card (a Pokémon from the deck, not an Energy), the title, "✓ Standard" (or the deck's own format), the card count, "Published <date>" and a cost.
- [ ] 3. Find a deck whose cost reads "$N+": rest the pointer on the cost and a tooltip says how many cards aren't priced yet. A deck with no cached prices reads "Price on page" in muted text.
- [ ] 4. Press Expanded: only Expanded decks remain and the chip shows as pressed. Press GLC with no GLC deck listed: "No legal decks match this search." Press Any: every deck returns.
- [ ] 5. Type part of a card name that's in one of your published decks: the grid narrows to the decks holding it. Clear the box.
- [ ] 6. Press a deck card: its Published Deck opens without a full page reload.
- [ ] 7. A Listed deck is a snapshot, so editing its Deck or changing its Target Format changes nothing here until you republish. Instead, in Owner controls → Attributes, correct one card of a Listed deck to regulation mark G (rotated out of Standard) and reload Discover: once the correction is delivered, the deck is gone. Remove the correction and reload: the deck returns, with no republish.

On a phone (iOS Safari or Android Chrome), signed in:

- [ ] 8. Open Discover from the public link or a Published Deck: it shows inside the app, with the bottom tab bar and no tab highlighted. Cards sit two to a row, nothing scrolls sideways, and the chips and cards are easy to hit with a thumb.
- [ ] 9. Scroll to the end of a long listing and press More decks: more cards load under the first ones.

### Decks index, Publish, Delete and exports (#181)

On a desktop (a window at least 1280 px wide):

- [ ] 1. Open Decks. Each Deck shows its name, "N/M in Deck" (or "Empty: plan a list"), its cost to complete once prices arrive, and a pill such as "Standard · ✓ Legal". "Discover decks" at the top opens Discover inside the app.
- [ ] 2. Open a Deck whose result isn't legal. Publish in the header is disabled, with the reason under it, such as "Publish needs a legal Standard deck: 2 issues".
- [ ] 3. Open a legal Deck and press Publish. The dialog explains what a Published Deck shows. Enter a title and press "Publish Unlisted snapshot": the dialog shows "<title> · Unlisted · version 1" with a link to the public page, and the header button reads "Published · v1".
- [ ] 4. Press List in Discover, then Republish snapshot: the dialog shows "Listed" and version 2. A few minutes later the Published Deck's page and Discover show its price.
- [ ] 5. Press **Buy missing**. The export opens on TCGplayer Mass Entry with "Cards you don't own" chosen; prepare it and only the cards you don't own are listed. Choose "The whole Deck List" and prepare again: every card is listed. Press Escape: focus returns to Buy missing.
- [ ] 6. Press **Export**: it opens on Pokémon TCG Live, which exports the whole Deck List.
- [ ] 7. Press **Delete**. The dialog says the cards go to Unsorted and a Published Deck stays live. Delete Deck stays disabled until you type the Deck's name; delete it. You're back on Decks with a toast, the cards are in Unsorted in Collection, and the publication is under Published Decks as "Its Deck was deleted. It stays live until you revoke it." Revoke it there (Revoke, then Revoke for good).
- [ ] 8. In Collection, open a Deck: its cards show under a banner with the cost and "Open in the deck builder", Move, Remove and Undo work as for any Location, and there's no Export menu.

On a phone (iOS Safari or Android Chrome):

- [ ] 9. Open Decks and a Deck: the header's Export, Publish and Delete wrap under the title, are easy to hit with a thumb, and nothing scrolls sideways. The Export, Publish and Delete dialogs open as sheets (Export fills the screen) and close with ✕.

### Deck builder: editing the Deck List (#177)

On a desktop (a window at least 1280 px wide):

- [ ] 1. Open a Deck. The Library column on the right lists your cards (Owned is chosen), each tile reading "free/owned" (copies not in this Deck, of copies you own) with its price, and the format chip of the Deck's Target Format is pressed; a card of unknown standing shows "?". Change another Deck's Target Format to Expanded and open it: its library starts on Expanded.
- [ ] 2. Choose All: cards you don't own appear, darkened. Type part of a name, then press a type chip and Any format: the list narrows and widens. Scroll the column: it scrolls on its own and keeps loading cards while the Deck List stays put.
- [ ] 3. Drag a tile onto the Deck List with the mouse: a "+1 name" badge follows the pointer and the Deck List is outlined. Drop it: one copy appears, N/60 goes up by one, and a toast says "Added 1 name." with Undo. Start another drag and press Escape before dropping: nothing changes.
- [ ] 4. Press Undo: the copy leaves and the toast says "Undone: …". Drag a copy from the Deck List onto the library: it leaves, and the toast says "Removed 1 name.". No card moved in Collection.
- [ ] 5. Tap a library tile: the card popup shows the card, its copies free of owned, its price and legality, and −1 / N on Deck List / +1. Press +1 ten times quickly: N reaches 10 at once and the Deck List shows 10 copies a moment later. The line under the stepper names the last change and offers Undo. ‹ › and ← → step through the library.
- [ ] 6. Press a copy on the Deck List: its sheet has −1 / N / +1 and "Swap this copy for", listing the card's other Editions with their copies. Choose one: the sheet closes, one copy changes Edition, and one Undo in the toast puts it back.
- [ ] 7. Tab to a copy and press Delete, then Backspace: each takes one copy off, and focus stays on the line; when its last copy goes, focus moves to the toast's Undo.
- [ ] 8. Make a change, then change the same Deck List in another tab, then press Undo on the first tab's toast: it says "Can't undo: this deck changed." and nothing is undone.

On a phone (iOS Safari or Android Chrome):

- [ ] 9. Open a Deck: Library is the first tab and keeps its search when you switch to Deck and back. Tap a tile: the popup rises as a sheet; tap +1 and close it: the Deck tab's count went up. On the Deck tab, tap a pile: its sheet has the stepper and Swap, every control is easy to hit with a thumb, and nothing scrolls sideways.

### Catalog: Add mode and Collection's Add cards (#175)

On a desktop (a window at least 1280 px wide):

- [ ] 1. Open Catalog and press **Add to a Location** at the right of the title. A bar appears above the search box reading "Adding to" with a Location picker on Unsorted, "Tap + on cards, then add them together.", and Clear and Add cards, both greyed out. Every tile has a + on its art.
- [ ] 2. Pick another Location in the bar. Press + on a card three times: it becomes − 3 +, the tile is outlined, the bar lists "3× …" and the button reads "Add 3 cards". Press − once: it reads 2.
- [ ] 3. Search for another card and press its +, then clear the search: both cards are still in the bar. Scroll down: the bar stays at the top.
- [ ] 4. Press a tile: the card popup's Collection row starts on the Location in the bar. Close it.
- [ ] 5. Press **Add N cards**. A toast reads "Added N cards to <Location>." with Undo, the bar is empty again, and the tiles' owned badges go up by N. Open Collection on that Location: the cards are there. Back in Catalog, press Undo: the toast reads "Undo removed N cards from <Location>.", and the copies are gone again.
- [ ] 6. In Collection, open a Location and press **Add cards**: the same gallery opens over Collection, titled "Add cards to <Location>", already set to it. Queue a few cards and press Add N cards: the gallery closes, you are in that Location with the new cards, and the toast's Undo takes them all out in one step.
- [ ] 7. Open All owned and press Add cards: the gallery is titled "Add cards" and asks for a Location. Pick one inside a folder, queue a card and add it: you land in that Location, with its folder open in the sidebar.

On a phone (iOS Safari or Android Chrome):

- [ ] 8. In Catalog, switch to Add to a Location: the bar shows the picker and the hint only. Tap a tile's +: Clear and Add 1 card appear. The + and − are easy to hit with a thumb, and nothing scrolls sideways.
- [ ] 9. In Collection, tap Add cards: the gallery fills the screen. Queue two cards and tap Add 2 cards: it closes onto the Location with the Undo toast above the tab bar.

### Published Deck (#183)

On a desktop (a window at least 1280 px wide), signed out:

- [ ] 1. Open a Listed deck from Discover. The page shows its title, "The card list is a snapshot from <date>; format results update automatically", a pill such as "Standard · ✓ Legal", "60 cards · $N · N/60 copies priced", and Copy for TCG Live, Buy on TCGplayer and Share.
- [ ] 2. The cards show in Spread, grouped like the deck builder (evolution lines, then Trainers by type, then Energy), each tile with one card's price under it and no ownership marks. Switch to Stacked (piles with "×4" and one card's price) and List (each line's quantity, name, Edition and the price for that many copies, such as "$40.00" for four $10.00 cards).
- [ ] 3. Press a card: the popup shows its art, set and number, Variant, "N copies", "$N each" and its Standard standing. ‹ › and the ← → keys step through the deck. Escape closes it and focus returns to the card.
- [ ] 4. Press the result pill: the results dialog shows the "As of" date, any issues with plain reasons, the rules version and the disclaimer.
- [ ] 5. Press Copy for TCG Live: the Live export is ready in the dialog (or lists what blocks it); Copy for Live copies it. Press Buy on TCGplayer: Mass Entry for the whole list is ready, with Open in TCGplayer when every card has a product. Press Share: "Link copied." and the link pastes elsewhere.

Signed in as the deck's owner:

- [ ] 6. Open your own Published Deck: it shows inside the app, with "Your Published Deck · Listed · vN" above the header. Press Make Unlisted: it reads Unlisted. Press Make Listed to list it again.
- [ ] 7. Open a Listed deck that isn't legal in its Target Format: the bar says "Hidden from Discover: not legal in Standard", and each card with a format issue is outlined with a "!".
- [ ] 8. Press Open Deck: the deck builder opens. Delete a test Deck that has a Published Deck, open its page: the bar says "Deck deleted" and has no Open Deck. Revoke, then Revoke for good: the page says "This deck isn't published anymore".

On a phone (iOS Safari or Android Chrome):

- [ ] 9. Open a Published Deck: the cards start in Stacked, nothing scrolls sideways, the header's buttons wrap under the title, and the card popup, the results dialog and both exports open as sheets that close with ✕.

### The dark first paint and the stylesheet's removal (#184)

On a desktop (a window at least 1280 px wide):

- [ ] 1. In the browser's developer tools, set the network to Slow 4G and reload Collection. From the first frame the page is dark with a muted "✦ PrizeCheck" in the middle; nothing white flashes, then the loading screen and Collection follow.
- [ ] 2. Sign out and reload the sign-in page with the cache disabled: the same dark page and wordmark come first, then the sign-in card.
- [ ] 3. Visit Collection, Decks, a Deck, Catalog, Missing cards, Owner controls (every tab) and Discover. Each looks as it did before this update: the same text sizes, spacing, lists with their bullets, links in text underlined, and form fields in regular weight.
- [ ] 4. Scroll past the end of a long page (Collection or Catalog) and pull past the top: the dark background continues, with no light band. The scrollbars are dark.
- [ ] 5. Open a Deck's Export, then Pokémon TCG Live: a blocked card list keeps its bullets. In Catalog, open a card's report forms from the popup: their headings keep their size.

On a phone (iOS Safari or Android Chrome):

- [ ] 6. Open the app from a cold start (close the tab first): the browser's own bar takes the dark theme colour and the page is dark from the first frame, with the wordmark until the app loads.
- [ ] 7. Visit Collection, Decks, a Deck and Catalog: nothing scrolls sideways, and every control is as easy to hit with a thumb as before.

## Manual checks that automation does not cover

- [ ] Real touch on iOS Safari and Android Chrome for the tab bar, the More sheet and the ☰ drawer (the browser tests only emulate touch), including the home indicator area under the tab bar.
- [ ] Screen reader walkthrough (VoiceOver on macOS and iOS, NVDA on Windows): the tabs announce the current page, the avatar menu announces as a menu, and the drawer and sheet announce their titles and return focus when they close.
- [ ] Safari and Firefox on desktop: the avatar menu, the sticky header and the dialogs (the browser tests run in Chromium only).
- [ ] Screen reader on the sign-in card: the heading and subtitle are read first, then each provider button as a link "Continue with <Provider>"; with email sign-in on, the Email and Six-digit code fields are named and "a code has been sent" is announced. On a slow load, "Loading…" is announced once (#163).
- [ ] Safari and Firefox on desktop, with a slow network: the first paint is dark with the wordmark, and the page switches to the app without a flash (#184; the browser test runs in Chromium only).
- [ ] Screen reader on Collection: with Names off, a tile is read with its Variant (or "Unspecified Variant"), and the inspector's Leaf list is read as a list (#164).
- [ ] Screen reader on Owner controls: the sub-tabs announce as tabs with their counts and which one is selected, the problems line reads as a list, and the health table reads as a table with its column headers (#167).
- [ ] Screen reader on the Owner controls queues: each Review button is read with its card and whether it is expanded, an open card is read as an article named for its card with the cursor in Review reason, and the message after a decision is announced once (#168).
- [ ] Screen reader on Missing cards: the sub-tabs announce as tabs and which one is selected, the reports table reads with its column headers, Reply announces whether its row is open, and after a send the message is read where focus lands (#169).
- [ ] Real touch and Safari on Collection: Manage locations' handle drag with a finger on iOS Safari and Android Chrome, and the sidebar's tile drag and the + on hover in Safari and Firefox on desktop (#166).
- [ ] Screen reader on the deck builder: each copy is read with its card, Edition, copy number and state (and the Location of a copy owned elsewhere), a Stacked pile with its counts, Spread / Stacked / List as a radio group, and on a phone Library and Deck as tabs with the Deck count (#176).
- [ ] Screen reader on Catalog: the search box is read with its hint, each chip with whether it is pressed, the set chip as opening a dialog, and each tile with its card, set and number, Variant, how many you own and, under a format chip, "legality unknown" for a "?" card (#173).
- [ ] Screen reader on the Decks page and the deck builder's header: each Deck is read as a link with its name, then its counts, cost and result; a disabled Publish is read with its reason; the Delete dialog's field is read as "Type the Deck name to confirm"; and Revoke's second step takes focus (#181).
- [ ] Screen reader on the Target Format control: ▾ is read as a menu button "Target Format: <Format>", its menu items as radio items with the chosen one checked, the result as a button with its status and issue count, a change announces the new result once, and a highlighted copy is described as having a format issue (#178).
- [ ] Screen reader on Add mode: the switch is read as "Catalog mode" with Browse and Add to a Location as radio buttons, each tile's buttons as "One more <card>" and "One fewer <card>", a queued tile with "N to add", the queued cards as the list "Cards to add", and a refused Add N cards as an alert; after Add N cards, focus lands on the toast's Undo (#175).
- [ ] Screen reader on the card popup: it is read by the card's name; ‹ › as Previous card and Next card with "N / M" between them; each step as "Card N of M: name"; each Edition as a toggle button with its Variant, copies owned and price, and whether it is pressed; and the footer links as "Report this Edition", "Report Printing metadata" and "Report a missing Edition" (#174).
- [ ] Screen reader on Discover: each deck card is read as a link named by its title, then its format ("Standard legal"), card count, published date and cost, including "N cards not priced yet" after a "$N+" cost; the chips are read with whether they're pressed, and the results line is announced when a search or chip changes the grid (#182).
- [ ] Screen reader on the deck builder's editing: each library tile is read with its card, set and number, Variant and "N free of M owned" (or "not owned"); the popup's and the copy sheet's −1 and +1 are read in a "Deck List copies" group with the count; each change's words are announced once; and each "Swap this copy for" Edition is read with its set, number, Variant and copies (#177).
- [ ] Screen reader on a Published Deck: the result pill is read as a button with the Format, its status and issue count; each tile with its card, Edition, copy number and price; a card with a format issue described as having one; Spread / Stacked / List as a radio group; the card popup by the card's name with "Card N of M: name" on each step; and the owner bar as a region named "Your Published Deck · <visibility> · v<N>" (#183).

## Sources

The [app redesign spec](spec.md), the [app shell resolution](wayfinder/resolutions/decide-app-shell.md), the [component kit resolution](wayfinder/resolutions/decide-component-kit.md) and the [rollout resolution](wayfinder/resolutions/decide-rollout-and-verification.md).
