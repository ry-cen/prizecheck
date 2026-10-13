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
- [ ] Collection's Location tree, Manage locations, search, filters and display settings, the stale-collection banner and the Deck heading use the new controls. Filters & display opens as a panel along the right edge of a phone, and Manage locations fills a phone's screen (#166).

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
- [ ] 7. Reprints shows how many items wait and says its review comes in a later update. Attributes lists its queue as a table (#170). (Catalog, Metadata and Missing cards have their own walkthrough under #168.)

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

## Sources

The [app redesign spec](spec.md), the [app shell resolution](wayfinder/resolutions/decide-app-shell.md), the [component kit resolution](wayfinder/resolutions/decide-component-kit.md) and the [rollout resolution](wayfinder/resolutions/decide-rollout-and-verification.md).
