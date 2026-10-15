# Spec — App redesign: one shell, one design system

**Status:** ready for tickets, 2026-10-12

**Decision map:** [App redesign — decision map](wayfinder/map.md). All twenty tickets are resolved and nothing is left unspecified. Each section below names the resolution it comes from.

## Problem Statement

PrizeCheck looks and behaves like several apps stitched together.

- Collection (still called the workspace) has its own dark design and its own header.
- Decks, Catalog, Missing cards, Owner controls, sign-in, Published Deck and Discover are still on the old light pages, with a different header, different controls and no layout for phones.
- Switching pages reloads the whole screen and loses what the collector was doing.
- The first paint before the app loads is white.

The Decks page can't do what Deck Lists already support on the server. Every Deck List route exists with a web client, but no page calls them. A collector can't:

- edit a Deck List, or see which copies are in the Deck, owned elsewhere or still to buy;
- run a Pick List;
- read the format results;
- see the cost to complete, or export only the cards they don't own;
- delete a Deck.

Today's Decks page shows only Holdings.

Several gaps sit behind the screens too:

- Card type has two sources, so a reviewed correction changes format results but not Collection's filter.
- A Gather can push Collection's Undo history out.
- Lines for cards the collector doesn't own carry no name or art.
- Nothing can filter the catalog by format, or return Card Editions with ownership merged in.
- The card attributes and Reprint Group reviews have server routes but no page, so a wrong Trainer Type can't be corrected in the app.
- Discover can list decks that aren't legal.
- A Deck has no single format it's built for.

## Solution

Every page moves into **one persistent, mobile-first app shell** on the shared dark design system.

- **The shell.** Desktop has top tabs (Collection, Decks, Catalog, Missing cards) and an avatar menu with Sign-ins, Owner controls (owner only) and Sign out. Phones have a bottom tab bar (Collection, Decks, Catalog, More), and ☰ opens the page's side content. Switching pages swaps only the page area, and every page keeps its state. Signed-out pages share a slim public header.
- **The kit.** Styling is Tailwind on our own tokens, with one React component kit ([ADR 0012](../../adr/0012-style-the-app-with-tailwind-on-our-tokens.md)).
- **Collection** (the renamed workspace, now at `/collection`) shows every Card Edition's Variant Descriptor and the per-Leaf breakdown of copies owned. The old Collection page is retired.
- **Decks** gains a deck builder:
  - the Deck List on the left, and a library of Card Editions on the right;
  - every copy shown as in the Deck, owned elsewhere or to buy;
  - Gather, Buy missing, Undo;
  - one Target Format per Deck, whose legal result gates publishing ([ADR 0011](../../adr/0011-publishing-needs-a-legal-target-format.md)).
- **Catalog** is an Edition gallery with one smart search box and a card popup. It has an **Add** mode that adds a stack of cards to a Location at once. Collection's Add cards opens the same gallery.
- **Published Deck** shows the read-only deck panel with prices. **Discover** lists only decks that are legal in their Target Format, with a cost read from cached prices.
- **Missing cards and Owner controls** use sub-tabs over sideways-scrolling tables, with the review card opening inline. Owner controls gains the card attributes and Reprint Groups queues.
- **Sign-in** is a centred card with branded Google and Discord buttons and final wording for every failure message. A Sign-ins settings page lists your linked sign-ins. The first paint is dark.

The redesign is a **launch gate**: nobody besides the owner uses PrizeCheck until every page is in the shell. Pages move one at a time on `dev`, in the seven stages under [Rollout](#rollout).

## User Stories

### The shell

1. As a collector, I want every signed-in page to share one header and navigation, so that PrizeCheck feels like one app.
2. As a collector on desktop, I want top tabs for Collection, Decks, Catalog and Missing cards, so that I can switch pages in one click.
3. As a collector on desktop, I want an avatar menu with my email, Sign-ins, Owner controls when I'm the owner, and Sign out, so that account actions are out of the way.
4. As a collector on a phone, I want a bottom tab bar with Collection, Decks, Catalog and More, so that I can switch pages with my thumb.
5. As a collector on a phone, I want More to open a sheet with Missing cards, Sign-ins, Owner controls (owner only) and Sign out, so that less-used pages are one tap away.
6. As a collector on a phone, I want ☰ to open the page's side content (Collection's Locations), so that the sidebar is there when I need it.
7. As a collector, I want switching pages to change only the page area, so that the header never reloads.
8. As a collector, I want a page I return to to keep its Location, selection, scroll position, search, filters and display choices, so that I don't lose my place.
9. As a collector, I want returning to a page to show no placeholder tiles and no change in size, so that the screen doesn't flicker.
10. As a collector, I want a reload to start a page fresh, so that a new visit is predictable.
11. As a collector, I want each page to have its own header with a title on the left and its actions on the right, so that I always know where page actions live.
12. As a collector, I want Collection to be the page I land on after signing in, so that my cards come first.
13. As a collector with an old bookmark, I want `/workspace` and `/locations` to open Collection, so that my links keep working.
14. As a collector, I want routing to happen in the app without full page loads, so that navigation is quick and a future desktop app stays possible.
15. As a collector on a phone, I want every target at least 44 px and no page that scrolls sideways, so that the app works one-handed.
16. As a collector who prefers reduced motion, I want no animation, so that the app respects my setting.
17. As a keyboard user, I want a visible focus ring everywhere, so that I can always see where I am.

### The design system

18. As a collector, I want every button, chip, menu, dialog and toast to look and behave the same on every page, so that I learn them once.
19. As a collector on a phone, I want dialogs to open as bottom sheets, so that they're easy to reach.
20. As a keyboard user, I want every dialog to trap focus, close on Escape and return focus to what opened it, so that I never get lost.
21. As a collector, I want one toast at a time, with Undo on the action it names, so that Undo is never ambiguous.
22. As a collector, I want icons that render the same on every device, so that controls look intentional.
23. As a collector, I want wide tables to scroll inside their own box, so that the page never scrolls sideways.

### Collection

24. As a collector, I want the workspace called Collection everywhere I see it, so that the name matches what it holds.
25. As a collector, I want every Card Edition's Variant Descriptor, or "Unspecified Variant", on the tile's Names line after set and number, so that I can tell a holo from a reverse holo.
26. As a screen-reader user, I want the Variant in every tile's accessible name and hover title, even with Names off, so that I hear which Edition it is.
27. As a collector, I want a Variant row in the inspector, so that the details panel names the Edition exactly.
28. As a collector, I want "N copies owned" in the inspector to expand into each Storage Leaf that holds the Edition, with its quantity and Location path, so that I can find every copy.
29. As a collector, I want Collection's Add cards to open the Catalog gallery in Add mode, set to the open Location, so that there's one card search in the app.
30. As a collector, I want Collection's category and type filters to use the reviewed card attributes, so that a correction shows up in my filters.
31. As a collector, I want an open Deck in Collection to keep its Holdings with Move, Remove and Undo, and to show a banner with its cost and a link to the Deck on Decks, so that physical work stays in Collection.
32. As a collector, I want the old Collection page gone, so that there's one place my cards live.

### Decks index

33. As a collector, I want the Decks page to list every Deck with its in-Deck count, cost to complete and one Target Format pill, so that I can see each Deck's state at a glance.
34. As a collector, I want a Published Decks section on the Decks page, orphans included, with Make Listed or Unlisted and Revoke, so that I can manage every publication in one place.
35. As a collector, I want a way from Decks to Discover, so that I can browse other decks.

### Deck builder

36. As a collector, I want opening a Deck to show the deck builder, with the Deck List on the left and a card library on the right, so that I can build while browsing.
37. As a collector on a phone, I want Deck and Library tabs, Library first, with the Deck tab showing the live count, so that both fit on a small screen.
38. As a collector, I want the library to show one tile per Card Edition with set, number, Variant, copies free out of copies owned, and price, so that I pick exactly the Edition I mean.
39. As a collector, I want an Owned / All switch starting on Owned, with unowned Editions darkened, so that I build from what I have first.
40. As a collector, I want a search box and format and type chips on the library, so that I can narrow the cards fast.
41. As a collector, I want the library's format chip to start on the Deck's Target Format, so that I see playable cards first.
42. As a collector, I want a format chip to hide only cards that aren't legal, and to show cards of unknown standing with a "?", so that a new set doesn't disappear in its first week.
43. As a collector, I want dragging a library tile into the Deck List to add one copy of that Edition, so that building is direct.
44. As a collector on a touch screen, I want tapping a tile to open the card popup with −1, N on Deck List and +1, so that I never need to drag.
45. As a collector, I want the card popup to show the card, its ownership, its price and its legality, with ‹ › or ← → to step through the results, so that I can compare cards without closing it.
46. As a collector, I want adding a card to the Deck List never to move a physical card, so that planning and sorting stay separate.
47. As a collector, I want Spread, Stacked and List views of the Deck List, with Spread the default on desktop and Stacked on phones, so that I can read it at different densities.
48. As a collector, I want each copy shown as in this Deck (solid), owned elsewhere and where (dashed, ↻) or not owned (ghost, $), so that I see what I still need to gather or buy.
49. As a collector, I want lines grouped by evolution line, Trainer Type and Energy, so that the list reads like a decklist.
50. As a collector, I want tapping a copy to open its sheet with what and where it is, ±1, Gather and Swap this copy for another Edition of the same Card Identity, so that I can change one copy precisely.
51. As a collector, I want a swap to undo in one step, so that Undo reverses what I did.
52. As a collector, I want dragging a copy onto the library, or pressing Delete or Backspace, to remove it, so that removing is quick.
53. As a collector, I want every add, remove or swap to show an Undo toast, so that mistakes are cheap.
54. As a collector tapping ±1 quickly, I want every tap to count, in order, so that fast editing doesn't lose taps.
55. As a collector, I want Undo to say "Can't undo: this deck changed" when the Deck List changed since, so that Undo never overwrites newer work.
56. As a collector, I want the deck header to show N/60, the deck cost and the cost to complete, Gather N and Buy missing, so that the next step is always visible.
57. As a collector, I want one "Standard ▾ · ✓ Legal" control, so that I can change the Target Format and open its result from one place.
58. As a collector, I want the results dialog to show an "as of" date with any future-rules note, deck-level and card-level issues with plain reasons, the rules version and the advisory disclaimer, so that I understand why.
59. As a collector, I want a card-level issue to highlight its lines in the Deck List, so that I can find the problem card.
60. As a collector, I want nothing blocked while I build, including going over 60 cards, so that results stay advisory.
61. As a collector, I want copies physically in the Deck but cut from the Deck List shown as surplus, with Put away, so that I can return them to a Location I pick.
62. As a collector, I want a warning when several Decks count the same spare copies, so that I don't plan the same card twice.

### Gather, cost and exports

63. As a collector, I want Gather N to open the Pick List as a dialog arranged by card, with a source picker on each row, so that I can choose where each copy comes from.
64. As a collector, I want a warning when a source sits in another Deck, saying it leaves that Deck short, so that I don't break another Deck by accident.
65. As a collector, I want Confirm picked and Confirm all, so that I can gather some cards now and the rest later.
66. As a collector, I want one Gather to write one Undo record, so that it never pushes my Collection Undo out.
67. As a collector, I want Buy missing to open the export dialog on TCGplayer Mass Entry, defaulting to the cards I don't own, with the whole Deck List as an option, so that I buy only what I need.
68. As a collector, I want the Live export to use the whole Deck List, so that I can play it in TCG Live.
69. As a collector, I want the Deck List cost and the cost to complete, each with how many copies have a price, so that I know how reliable the total is.

### Publish and delete

70. As a collector, I want Publish disabled while my Target Format result isn't legal, with the reason ("Publish needs a legal Standard deck: 2 issues"), so that I know what to fix.
71. As a collector, I want Publish to show the snapshot's title, visibility and version, with Republish, List in Discover and Revoke, so that I manage the publication from the Deck.
72. As a collector, I want publishing to start a background price refresh for the deck's cards, so that my listing is priced on Discover.
73. As a collector, I want Delete to ask me to type the Deck's name, and to say the cards go to Unsorted and any Published Deck stays live, so that I can't delete by accident.

### Catalog

74. As a collector, I want Catalog to show one tile per Card Edition, the same tile as Collection and the library, with set, number, Variant, price and an owned badge, and unowned Editions darkened, so that it looks like the rest of the app.
75. As a collector, I want one search box where "PAL 185" or "svi 191" searches by set and collector number and anything else by name, with a hint showing which, so that I can type what's on the card.
76. As a collector, I want format and type chips, a set picker and an Owned only chip in one row under the search box, so that filters stay in one place.
77. As a collector, I want the status line ("N Printings", "changed, refreshed", and "unavailable until the first import"), so that I know what the catalog holds.
78. As a collector, I want tapping a tile to open the card popup with ‹ N / M ›, the art, the Printing details, legality pills, the Editions with owned counts and prices, and where my copies are, so that one popup answers everything.
79. As a collector, I want the popup's Collection row (Location, − N +, Add N), so that I can add a card where I need it.
80. As a collector, I want Report links (this Edition, Printing metadata, a missing Edition) in a quiet footer, and My reports at the foot of the page, so that reporting stays available but out of the way.
81. As a collector entering a stack of cards, I want a Browse / Add switch in the page header, so that I can switch to adding.
82. As a collector in Add mode, I want a + on every tile that becomes a −/N/+ stepper, with queued tiles outlined, so that I can queue many cards quickly.
83. As a collector in Add mode, I want one bar stuck to the top with Adding to [Location], the queued cards, Clear and Add N cards, so that the target and the queue stay visible.
84. As a collector, I want Add N cards to add the whole queue at once and undo in one step, so that a stack goes in or out as one action.
85. As a collector opening Add cards from a Location, I want the gallery already in Add mode and set to that Location, and to land back in it with an Undo toast, so that adding fits where I was.
86. As a collector opening Add cards from All owned or a folder, I want a Location picker, so that I choose the target first.
87. As a collector on a phone, I want Add cards to fill the screen and the card popup to be a bottom sheet, so that both are usable.

### Published Deck and Discover

88. As a visitor, I want Published Deck and Discover under the slim public header, so that I can read them without an account.
89. As a signed-in collector, I want them inside the full shell, so that I don't leave the app.
90. As a visitor, I want the Published Deck header to show the title, the snapshot date, the Target Format result, the total and how many copies are priced, so that I know what I'm looking at.
91. As a visitor, I want Copy for TCG Live, Buy on TCGplayer and Share, so that I can play, buy or pass on the deck.
92. As a visitor, I want the read-only deck panel in Spread, Stacked or List, with a price per card on tiles and per line in List, so that I can see what each card costs.
93. As a visitor, I want a read-only card popup with art, Edition, price and Target Format legality, stepping through the deck, so that I can inspect any card.
94. As a visitor, I want a card-level issue to highlight its tiles, so that I see why a deck isn't legal.
95. As the deck's owner, I want an owner bar with its visibility and version, Make Listed or Unlisted, Revoke and Open Deck ("Deck deleted" for an orphan, and "Hidden from Discover: not legal in Standard" when it's hidden), so that I manage it from the page.
96. As a visitor, I want Discover to show a grid of deck cards, newest first, each with a featured card, title, card count, Target Format pill, published date and cost, so that I can find a deck to build.
97. As a visitor, I want Discover filtered by search and by format chips that match each deck's Target Format, so that I find decks for the format I play.
98. As a visitor, I want only decks that are legal in their Target Format today listed, so that every listed deck is playable.
99. As a visitor, I want the cost to read "$142", "$118+" with a "3 cards not priced yet" tooltip, or "Price on page", so that I know whether the total is complete.
100. As a collector, I want no public page or route ever to reveal ownership or storage, so that my collection stays private.

### Missing cards

101. As a collector, I want Missing cards to have My reports and Report a card sub-tabs, so that filing and following are separate.
102. As a collector, I want My reports as a table of card, kind, status, sent date and the owner's latest response, so that I can see where each report stands.
103. As a collector whose report needs information, I want Reply to open inline with the conversation and a reply box, so that I can answer in place.
104. As a collector, I want Report a card to offer Missing Printing (set ID, set name, number, English name) or Missing Edition (Printing and the physical variant details), with an evidence link and a note, so that I report precisely.
105. As a collector, I want metadata reports to stay in Catalog's card popup, so that they're filed where the card is.

### Owner controls

106. As the owner, I want a line of health problems at the top, worst first, so that I see what's wrong before anything else.
107. As the owner, I want sub-tabs (Status, Catalog, Metadata, Attributes, Reprints, Missing cards, Rules), each queue with its count, so that I can go straight to a queue.
108. As the owner, I want Status to show the catalog pull (last success, phase, progress bar, counts, Refresh, Start full pull, and Restart pull with a warning when progress is stale) and operational health as a table, so that I can check the system at a glance.
109. As the owner, I want each queue as a table of card, set and number, kind, reports, opened and age with Review, and Load more where today's queue pages, so that I can work a long queue.
110. As the owner, I want Review to open the review card inline under its row, pinned to the table's visible width, so that I keep my place in the queue.
111. As the owner, I want a catalog reconciliation card to show the incoming change, the replacement Printing and the per-Edition mapping with each Edition's Holdings count, so that I can map every Edition.
112. As the owner, I want a metadata card to show source and reviewed values side by side with differences highlighted, linked reports with Ask for information and Reject report, product ID and quote variant, and the decision history, so that I decide with the evidence in front of me.
113. As the owner, I want a card attributes queue showing the derived value, correction and effective value for each attribute, Trainer Type included, with Correct or Remove correction, so that I can fix a card's type in the app.
114. As the owner, I want a Reprint Groups queue showing each Card Identity's Printings with their regulation mark, group and legality, and Move to and merge actions, so that I can fix functional identity in the app.
115. As the owner, I want a missing-card card with the report, its note and evidence, and the verified fields, and Begin a record directly above the table, so that I can create shared records.
116. As the owner, I want Request information and Reject on a missing-card report to need only a reason, so that simple replies stay quick.
117. As the owner, I want every other decision to take a reason, a review evidence URL and a fresh six-digit code on the card (Send code, the code, Confirm decision), so that catalog changes stay deliberate.
118. As the owner, I want a confirmed decision to remove its row and show a toast, so that I can see the queue shrink.
119. As the owner, I want rule cards with the active and latest versions, the digest and Activate with a code, so that I can approve new rules.

### Sign-in, Sign-ins and loading

120. As a visitor, I want sign-in to be a centred card reading "Sign in to PrizeCheck" and "Know every card you own, and where it is.", so that I know where I am.
121. As a collector sent from a protected page, I want the subtitle "Sign in to continue where you left off.", so that I know I'll go back.
122. As a collector, I want branded Continue with Google and Continue with Discord buttons as plain links, so that they're familiar and open normally.
123. As the owner, I want a provider added later to get a generic button with no page change, so that adding providers is configuration only.
124. As a collector, I want the email form only when email sign-in is on, so that I'm never offered a method that does nothing.
125. As a collector, I want a failure message above the buttons, announced and focused once, with the error removed from the address bar, so that I can recover straight away.
126. As a visitor while sign-ups are closed, I want "PrizeCheck isn't open to new collectors yet." shown as calm news with a link to public decks, so that it doesn't look broken.
127. As a collector, I want a Sign-ins page showing my email once, each provider with its connected date and Remove, or Connect, and Remove only when more than one sign-in is linked, so that I manage how I sign in.
128. As a collector, I want the page to be dark from the very first paint, with a quiet wordmark while the app loads and no placeholder tiles, so that nothing flashes.
129. As a visitor with an old link, I want "This deck isn't published anymore" or "Page not found", with Discover decks and Sign in, so that I have somewhere to go.

### Owner and developer

130. As the owner, I want every page to pass axe at WCAG 2.2 AA at desktop and phone widths, with dialogs open as well as closed, so that the app stays accessible.
131. As the owner, I want a short walkthrough checklist per page in the launch checklist, so that I check each page by hand before launch.
132. As a developer, I want one source for card type, so that filters, chips and format checks agree.
133. As a developer, I want Format Standing stored and indexed, so that format filters return full, stable pages.
134. As a developer, I want Deck List lines to carry their display data, so that unowned lines render without a second lookup.
135. As a developer, I want colours only from the token roles, with arbitrary colour values banned by lint, so that themes keep working.

## Implementation Decisions

### Terms

This spec uses `CONTEXT.md` vocabulary: Collection, Location, Storage Leaf, Holding, Card Printing, Card Edition, Variant Descriptor, Card Identity, Reprint Group, Deck, Deck List, Pick List, Format, **Format Standing**, **Trainer Type**, **Target Format**, Published Deck. "Collection" is the page formerly called the workspace. Code identifiers stay as they are (for example the workspace directory); only user-facing names change.

### Modules

| Module | Builds or changes |
| --- | --- |
| Styling and kit | Tailwind v4 through its Vite plugin; tokens become the theme; Tailwind's own palette, type scale and radii off; a lint rule banning arbitrary colour values; one base stylesheet (background, text colour, `color-scheme: dark`, one focus ring); the component kit. The old global stylesheet and the workspace CSS files are deleted once nothing uses them. |
| App shell | Desktop tabs and avatar menu, phone bottom bar and More sheet, ☰ drawer for page side content, page headers, kept-mounted pages, client-side router, redirects, the slim public header. |
| Collection | Rewrite of the workspace styling onto the kit; Variant on tiles, accessible names and the inspector; per-Leaf breakdown; Add cards opens Catalog's Add mode; filters on reviewed attributes; Deck banner. The old Collection page and its view are removed. |
| Decks | Decks index, deck builder, Pick List dialog, results dialog, export dialogs, Publish and Delete. Today's Holdings panel and Open in workspace link on Decks are removed. |
| Catalog | Edition gallery, smart search, filters, card popup, Add mode and its bar, the Add cards gallery over Collection. The old Add cards dialog and its form are removed. |
| Public pages | Published Deck and Discover on the kit, inside the public header or the shell. |
| Missing cards and Owner controls | Sub-tabs, ScrollTable queues, inline review cards, the code step, the new attributes and Reprint Groups queues. |
| Sign-in and Sign-ins | Sign-in card, provider buttons, email form, message allowlist with final wording, Sign-ins page, loading, unavailable and not-found states, first paint. |
| Catalog browse API | The Edition browse route. |
| Format Standing | Stored standings, their key, eager rebuilds and the reader fallback. |
| Card attributes | Trainer Type and evolves-from derivation, backfill, review, and Collection's filters moving onto them. |
| Deck List API | Display data on lines, the batch change command, Target Format. |
| Holdings and Undo | Batch add with the `add` Undo kind; Gather on the multi-source Move path. |
| Publishing and public API | Publish gate, snapshot Target Format, public format checks, public per-Edition cost, Discover summaries, filter and listing. |

### Styling and the kit

From [Decide the shared component kit](wayfinder/resolutions/decide-component-kit.md) and [ADR 0012](../../adr/0012-style-the-app-with-tailwind-on-our-tokens.md).

- **Kit components:**
  - Button (primary, secondary, quiet, danger, icon-only);
  - Chip, Pill (including one that opens something), Segmented;
  - SearchField, Select, Stepper (− N +);
  - Dialog, Menu, Toast;
  - EditionTile and CopyTile;
  - CardPopup;
  - ScrollTable;
  - EmptyState, LoadingState, ErrorState (with Retry);
  - Icon (a wrapper for `lucide-react` that sets size and `aria-hidden`).

  No headless component library is used.
- **Dialog** is one component on the native `<dialog>`: centred on desktop and a bottom sheet on phones (≤760 px). It owns the focus trap, focus return to the opener, Escape and the scrim, replacing the workspace's hand-rolled dialogs and drawers.
- **Toast** has one host for the app. One toast at a time, with Undo on the action it names. A new action replaces it.
- **ScrollTable** scrolls sideways inside its own focusable, labelled container, never the page.
- **Sizes:**

  | | Desktop | Phone (≤760 px) |
  | --- | --- | --- |
  | Buttons, search, selects, steppers | 30 px | 44 px |
  | Chips, pills, segmented switches | 24 px | drawn at 24–30 px, with a 44 px tap area |
  | Tile quick buttons (+, ±) | 26 px | drawn at 36 px, with a 44 px tap area |
  | Type | 13 px controls · 12 px meta · 11 px captions · 14 px body | same |

  The phone tap-area extension is a kit behaviour.
- **Variant Descriptor placement:**
  - on EditionTile and CopyTile, on the Names line's second line after set and number (`Paldea Evolved · 185 · Reverse Holo`), truncated with an ellipsis, and not drawn with Names off;
  - always in the tile's accessible name and hover title;
  - a Variant row in the inspector.

  "Unspecified Variant" is shown the same way. There's no badge and no tile height change.
- The gallery's fixed tile heights stay as theme variables, because its layout model depends on them.

### The shell

From [Prototype the app shell and navigation](wayfinder/resolutions/decide-app-shell.md).

- **Desktop header:**
  - the PrizeCheck wordmark, then tabs: Collection, Decks, Catalog, Missing cards;
  - an avatar menu on the right with the email, Sign-ins, Owner controls (owner only) and Sign out;
  - the avatar shows the provider picture, or the first letter of the email ([OAuth spec](https://github.com/ry-cen/prizecheck/issues/147)).
- **Side content and page headers.** A page with side content shows it in a left sidebar on desktop and a ☰ left drawer on phones. Collection's is the Location tree. Decks and Catalog have none. Each page has a page header with the title on the left and actions on the right; on a phone the actions sit on their own row under the title, left-aligned.
- **Phone:**
  - a slim top header with ☰ (or the wordmark) and the page's header controls (Collection: Search, and Filters & display); the page title is the page header's h1 below it, not repeated here;
  - a bottom tab bar with Collection, Decks, Catalog and More. More opens a sheet with Missing cards, Sign-ins, Owner controls (owner only) and Sign out;
  - Collection's Actions strip and Undo toast sit above the tab bar.
- **Pages keep their state.** Pages stay mounted when you leave them, keeping state, scroll and data, and return without placeholders or size changes. This covers [Workspace flashes gray placeholder tiles and jumps in size on every Location switch](https://github.com/ry-cen/prizecheck/issues/121). A reload or new visit starts fresh, which reverses the workspace's "leaving clears the selection" rule for tab switches only.
- **Routing:**
  - client-side only;
  - `/collection` is the default after sign-in;
  - `/`, `/workspace` and `/locations` redirect to `/collection`;
  - Discover is not a tab.
- **Signed-out pages.** Published Deck, Discover, sign-in, unavailable and not found share a slim public header: the wordmark, a Discover decks link and Sign in. Signed in, Published Deck and Discover render inside the shell.
- Mobile Select mode placement on Collection stays as today.

### Collection

From the [old Collection page audit](wayfinder/resolutions/audit-old-collection-page.md), the [component kit](wayfinder/resolutions/decide-component-kit.md), the [Deck experience](wayfinder/resolutions/decide-deck-experience.md) and the [workspace reconciliation](wayfinder/research/reconcile-workspace-tickets.md).

- **Styling.** Every workspace style rule becomes utilities or kit components. Behaviour stays as delivered, apart from what this spec changes.
- **Per-Leaf breakdown.** The inspector's "N copies owned" expands into each Storage Leaf holding the Edition, with its quantity and Location path, from the distribution read the inspector already makes.
- **Add cards** opens Catalog's gallery in Add mode over Collection:
  - from a Location, titled "Add cards to [Location]" and set to it;
  - from All owned or a folder, with a Location picker.

  Confirming adds the cards, closes the gallery and leaves you in the Location with an Undo toast.
- **Filters.** Category and type filters read the effective card attributes (see [Card type](#card-type-one-source)).
- **An open Deck** keeps its Holdings with Move, Remove and Undo. Its heading becomes a banner with the cost and a link to the Deck on Decks. Collection's Deck export menu is removed; exports live on Decks.
- **The old Collection page** and its view are removed. `GET /api/collection` loses its last web caller. Removing the route and its tests is follow-on cleanup, not part of this spec.

### Decks and the deck builder

From [Prototype the Deck experience](wayfinder/resolutions/decide-deck-experience.md), amended by [Decide the Published Deck and Discover pages](wayfinder/resolutions/decide-published-deck-and-discover.md) and [the data contracts](wayfinder/resolutions/decide-data-contracts.md).

- **Decks index:**
  - every Deck with its in-Deck count, cost to complete and one Target Format pill;
  - a **Published Decks** section listing every publication, orphans included, with Make Listed or Unlisted and Revoke;
  - a link to Discover.
- **Builder layout:**
  - the Deck List is the main area on the left;
  - the library is a narrower right column that scrolls on its own;
  - phones get Deck and Library tabs, Library first, with the live count on the Deck tab;
  - the page header holds Export, Publish and Delete.
- **Library:**
  - EditionTiles from the browse route with `deck_id`, showing copies free (owned and not in this Deck) out of copies owned, and price;
  - Owned / All, starting on Owned, with unowned Editions darkened;
  - a search box, format chips (Any, Standard, Expanded, GLC; starting on the Target Format) and type chips (Pokémon, Supporter, Item, Tool, Stadium, Energy);
  - a format chip hides only `not_legal` cards, and `unknown` cards show a "?" pill whose reason is in the popup.
- **Adding:**
  - a drag from the library adds one copy of that Edition;
  - a tap opens CardPopup with −1 / N on Deck List / +1 and ‹ › stepping;
  - adding never moves a physical card.
- **Deck List:**
  - Spread (one tile per copy; desktop default), Stacked (piles per Edition with a summary such as "×4 1↻ 1$"; phone default) and List (−/+, Edition, ownership counts, price);
  - each copy's state is in this Deck (solid), owned elsewhere and where (dashed, ↻) or not owned (ghost, $);
  - groups are evolution line (from evolves-from), Trainer Type and Energy;
  - **surplus**, copies physically in the Deck but cut from the list, has its own group with **Put away**, a Move to a Location the collector picks. Undoing a Put away returns the copies to the Deck as surplus and leaves the Deck List as it is: the one exception to copies arriving in a Deck joining its Deck List (owner decision, 2026-10-14);
  - the **competition warning** shows when several Decks count the same spare copies.
- **The copy sheet** shows what and where the copy is, ±1, Gather, and **Swap this copy for** another Edition of the same Card Identity. Dragging a copy onto the library, or Delete or Backspace, removes it.
- **Dragging** uses pointer events, as Collection's tile drag does:
  - mouse and pen only, with a 6 px threshold;
  - a badge follows the pointer and the drop target is highlighted;
  - Escape cancels, and the click after a drag is swallowed.

  Touch uses taps. Every drag has a tap equivalent (WCAG 2.5.7).
- **Edits and Undo:**
  - every add, remove or swap goes through the batch Deck List change command;
  - the client sends one command at a time and merges taps queued behind it into the next batch;
  - every edit shows an Undo toast that sends the inverse batch;
  - `STALE_DECK_LIST` shows "Can't undo: this deck changed";
  - Deck List Undo and inventory Undo never undo each other.
- **Deck header:**
  - row 1: N/60, "$deck · $to complete", Gather N, Buy missing;
  - row 2: the Target Format control ("Standard ▾ · ✓ Legal") and the Spread / Stacked / List switch.

  ▾ changes the Target Format through its command, and the result opens the results dialog. Nothing is blocked: a Deck List can go over 60.
- **Results dialog:**
  - an "as of" date with the future-rules note;
  - the Target Format's deck-level and card-level issues with plain reasons;
  - the rules version and the advisory disclaimer.

  A card-level issue highlights its lines.
- **Gather (the Pick List):**
  - a dialog arranged by card, with a source picker per row;
  - a source in another Deck carries a "leaves that Deck short" warning;
  - Confirm picked and Confirm all;
  - each confirmation is one multi-source Move with one Undo record, and the five-source batching is gone.
- **Exports:**
  - **Buy missing** opens the Mass Entry export defaulting to not owned, with the whole Deck List as an option. The web clients' defaults change; the server already defaults to `not_owned`;
  - the Live export uses the whole Deck List;
  - cost shows the Deck List cost and the cost to complete, each with how many copies have a price.
- **Publish:**
  - disabled while the Target Format result isn't `legal`, with the reason ("Publish needs a legal Standard deck: 2 issues");
  - its dialog shows the title, visibility and version, with Republish, List in Discover and Revoke.
- **Delete** asks for the Deck's name to be typed, says the cards go to Unsorted and says any Published Deck stays live. It uses the existing delete route.

### Catalog

From [Prototype Catalog search in the shell](wayfinder/resolutions/decide-catalog-search.md), amended by the data contracts.

- **Gallery:**
  - EditionTiles from the browse route, with set, number, Variant, price and an owned badge;
  - unowned Editions darkened, and "Artwork unavailable" for missing art;
  - no sidebar.
- **Search:**
  - one SearchField. A query that starts with a known set id followed by a number is a set and collector number search; anything else is a name search;
  - a hint names the mode.
- **Filters** sit in one row under the search box: format and type chips in a scrolling row that fades at its edge, a set picker styled as a chip, and an Owned only chip.
- **Status line:** "N Printings", plus today's "changed, refreshed" and "unavailable until the first import" handling.
- **CardPopup (Browse):**
  - ‹ N / M › beside ✕, with ← → stepping;
  - the art;
  - set name, ID and number, and regulation mark;
  - the Card Identity when it differs from the name;
  - an owner-reviewed note, with its evidence, on a manual record only;
  - legality pills for each Format;
  - an Edition picker, each Edition with Variant, owned count and price, plus owner-reviewed and unavailable badges;
  - a price is the amount alone, or a short state ("Checking prices…", "Price check timed out", "Price unavailable"): no source, price age, last check, refresh state or reason, here or anywhere a collector sees a price;
  - where your copies are;
  - the Add row: Collection | Location | − N + | **Add N** (Deck Lists are planned in the deck builder, not here);
  - a quiet footer: "Report: this Edition · Printing metadata · a missing Edition". My reports sits at the foot of the page.
- **Add mode:**
  - a **Browse / Add to a Location** Segmented in the page header;
  - Add mode shows one bar stuck to the top with Adding to [Location], the queued cards, Clear and **Add N cards**. On a phone, Clear and Add appear once something is queued;
  - every tile gets a + that becomes a −/N/+ stepper, and queued tiles are outlined;
  - Add N cards calls the batch add once, with one Undo toast;
  - the popup still opens, and its Add row starts on the target Location.
- **Phones:** the Add cards gallery fills the screen and the popup is a bottom sheet.

### Published Deck and Discover

From [Decide the Published Deck and Discover pages](wayfinder/resolutions/decide-published-deck-and-discover.md), [ADR 0011](../../adr/0011-publishing-needs-a-legal-target-format.md) and the data contracts.

- **Published Deck header** (`/published/:token`):
  - the title, then "The card list is a snapshot from [date]; format results update automatically";
  - the Target Format result as a Pill that opens the results dialog;
  - the total and priced-copy count;
  - **Copy for TCG Live** (primary; blockers in its dialog), **Buy on TCGplayer** (Mass Entry for the whole list) and **Share** (copy link).
- **Published Deck cards and prices:**
  - the deck panel, read-only, in Spread, Stacked and List with the builder's defaults;
  - plain tiles with no ownership marks and no key;
  - a card-level issue highlights its tiles;
  - Spread and Stacked tiles show the price of one card; List lines show the price for that many copies ("4 Iono PAL 185 · Normal · $4.40");
  - no price age is shown or sent;
  - the read-only CardPopup shows the art, Edition, price and Target Format legality, with ‹ ›.

  The old four-copy check list is dropped.
- **Owner bar** (only for the signed-in owner):
  - "Your Published Deck · Unlisted · v3", with Make Listed or Unlisted, Revoke and Open Deck;
  - "Deck deleted" for an orphan, with no Open Deck;
  - "Hidden from Discover: not legal in Standard" while the snapshot isn't legal.

  Republish lives on the Deck.
- **Discover** (`/discover`):
  - a grid of deck cards, newest first, each with a featured card, title, card count, a ✓ Target Format pill, published date and cost;
  - a search box (title or card name), and format chips (Any, Standard, Expanded, GLC) that filter by Target Format;
  - cost reads "$142" when every priced copy has a cached quote, "$118+" with a "N cards not priced yet" tooltip when some don't, and "Price on page" (muted) when none do. Stale cached quotes count as priced.

### Missing cards and Owner controls

From [Prototype Missing cards and Owner controls](wayfinder/resolutions/decide-owner-and-missing-cards.md).

- **Missing cards:**
  - Segmented sub-tabs: My reports and Report a card;
  - **My reports** is a ScrollTable of card, kind, status Pill, sent date and the owner's latest response. A report that needs information has Reply, which opens an inline row with the conversation and a reply box;
  - **Report a card** is today's form on the kit, with the same fields;
  - only missing-card reports are listed. Metadata reports stay in Catalog.
- **Owner controls:**
  - a line of Pills listing every health check that isn't OK, worst first;
  - sub-tabs with counts: Status, Catalog, Metadata, Attributes, Reprints, Missing cards, Rules. On a phone, the tab row scrolls sideways inside its own container.
- **Status:**
  - the pull panel: last success, run phase, a progress bar, the enumerated, fetched and validated counts, Refresh and Start full pull. When progress is stale, the button reads Restart pull, with a warning;
  - operational health as a ScrollTable of area, check, value Pill and detail.
- **Queues:**
  - each queue is a ScrollTable of card, set and number, kind, reports, opened, age and Review. Metadata keeps Load more;
  - Review opens the review card in an inline row, as wide as the table's visible area and pinned to its left edge. One item is open at a time, with Close.
- **Review cards:**
  - **Catalog:** the incoming source change, the replacement Printing, and the per-Edition mapping table with each Edition's Holdings count;
  - **Metadata:** source and reviewed values side by side with differences highlighted; linked reports with Ask for information and Reject report; product ID and quote variant; the decision history, folded away;
  - **Attributes (new UI on existing routes):** derived, correction and effective values per attribute (card kind, Trainer Type, regulation mark, rule box, ACE SPEC, evolves-from and the rest). The decision is Correct or Remove correction, and linked reports close with it;
  - **Reprints (new UI on existing routes):** each Card Identity in review as a ScrollTable of its Printings with regulation mark, current Reprint Group and its legality, and a Move to picker. Decisions move Printings between groups or merge Card Identities;
  - **Missing cards:** the report, its note and evidence, and the verified fields. Begin a record directly is folded above the table;
  - **Rules:** a card per rule kind with the active and latest versions and digest, and Activate when a newer version is ready.
- **Deciding:**
  - a reason and a review evidence URL come first, except on missing-card reviews, whose own fields include evidence;
  - Request information and Reject on a missing-card report need only the reason;
  - every other decision is a Decision Select, then the code step on the card: Send code, the six-digit code, then Confirm decision or Approve shared record;
  - a confirmed decision removes its row and shows a toast.

### Sign-in, Sign-ins, loading and first paint

From [Prototype sign-in and loading screens](wayfinder/resolutions/decide-sign-in-and-loading.md) and the [OAuth spec](https://github.com/ry-cen/prizecheck/issues/147), which fixes the behaviour.

- **The sign-in card:** a centred card, 400 px on desktop and full width on a phone, holding:
  - "Sign in to PrizeCheck";
  - "Know every card you own, and where it is.", or "Sign in to continue where you left off." when `next` is set;
  - the failure message, if any;
  - one provider button per configured provider;
  - the email form when email sign-in is on;
  - a terms and privacy line.
- **Provider buttons** are plain links to the sign-in start route with `next` when set. They're drawn from `GET /auth/methods` through a per-provider asset map, and a provider with no entry gets a generic kit button with its initial. They're 40 px tall on desktop and 44 px on a phone.
  - **Google:** fill #131314, a 1 px #8E918F stroke, #E3E3E3 text, the standard-colour G and "Continue with Google".
  - **Discord:** blurple #5865F2, the white logo unmodified, and "Continue with Discord".
  - Ship each company's downloaded asset.
- **Email form,** below an "or" divider:
  1. Email, then Email me a code.
  2. "We sent a six-digit code to …", the code field, then Sign in.
  3. Use a different email and Send a new code.
- **Failure messages** are mapped through the allowlist. Each is an alert directly above the buttons, focused once. Then `error` and `error_description` are removed from the address bar. Provider free text is never shown.

  | Group | Title | Follow-up | Next step |
  | --- | --- | --- | --- |
  | Cancelled | Sign-in was cancelled. | Nothing was changed. Choose a way to sign in below. | The buttons |
  | Not open yet | PrizeCheck isn't open to new collectors yet. | Sign-ups open once testing is done. Until then, anyone can browse public decks. | Browse public decks |
  | Needs a verified email | Your {Provider} account needs a verified email address. | Verify your email with {Provider}, then try again, or choose another way to sign in. | The buttons |
  | Belongs to another account (Sign-ins only) | That {Provider} sign-in is already connected to a different PrizeCheck account. | Sign in with that account to manage it, or connect a different one here. | Back to Sign-ins |
  | Sign in again (Sign-ins only) | For your security, sign in again to change your sign-ins. | You'll come straight back here afterwards. | Sign in again, returning to Sign-ins |
  | Too many attempts | Too many sign-ins right now. | Try again in a little while. | None |
  | Didn't complete | Sign-in didn't complete. | Try again. If it keeps happening, try another way to sign in. | The buttons |

  - Not open yet uses the accent wash, and every other message uses the danger colours.
  - Groups for the Sign-ins page only read as Didn't complete on the sign-in page.
- **Sign-ins page:**
  - "Your account email: …" once;
  - a row per configured provider with its mark, name, and "Connected <date>" or "Not connected";
  - Connect (a link) on an unconnected row;
  - Remove on a connected row, only when more than one is connected;
  - the closing line "You can sign in with any connected account. Your last sign-in can't be removed.";
  - its messages above the list.
- **First paint.** The HTML document carries an inline style with `html { background: #121110; color-scheme: dark }`, `color-scheme` and `theme-color` meta tags, and a static "✦ PrizeCheck" wordmark inside the React root, which React replaces. Those colours copy token values and must be kept in step with them.
- **Loading** shows the same wordmark on the dark page. "Loading…" appears after 600 ms. There are no placeholders and no shell skeleton.
- **Unavailable** ("This deck isn't published anymore", with "Its owner stopped sharing it, or the link changed. Published decks are snapshots, so an old link can stop working.") and **not found** ("Page not found", with "The link may be mistyped, or the page has moved.") are centred cards under the public header. Each offers Discover decks (primary) and Sign in.

### Catalog browse route

From [the data contracts](wayfinder/resolutions/decide-data-contracts.md), section 1. Route and field names are working names; their meaning is fixed.

- **`GET /api/catalog/editions`** is signed-in only and never public. Catalog and the builder's library both use it.
- **Each row is one Card Edition:**
  - Edition id and Printing id;
  - name, set id and name, collector number;
  - Variant Descriptor (or Unspecified Variant);
  - image URL, card kind, Trainer Type and evolves from;
  - Format Standing in all three Formats;
  - copies owned in total. With `deck_id`, also copies in that Deck and copies free elsewhere.
- **Query:**
  - `q` is the smart search, and may be empty;
  - filters are `kind` (Pokémon, Supporter, Item, Tool, Stadium, Energy), `format` (hides `not_legal` only), `set_id` and `owned`.
- **Paging:** keyset, 60 rows a page, with a signed cursor bound to the catalog revision, the owner revision and the Format Standing key. A change returns 409 and the client starts again, as Collection does.
- **The popup's "where your copies are"** keeps the existing per-Edition collection read.
- **`GET /api/catalog/search`** stays for its existing callers.

### Stored Format Standing

From the data contracts, section 2.

- **Storage:**
  - a table of one row per Card Printing and Format, with its Format Standing (`legal`, `not_legal`, `unknown`), computed with the evaluator's per-line standing (Reprint Group legality and bans included) over the stored format facts. A Card Edition has its Card Printing's standing;
  - a key row per Format: rules file sha256, evaluator code sha256, attribute revision, catalog revision and the next rule date, matching the key of saved Deck results.
- **Rebuilds:**
  - catalog imports, attribute decisions and a rules deploy rebuild the affected Format;
  - a scheduled job rebuilds on each rule date;
  - a reader that finds the key stale rebuilds that Format in bulk under an advisory lock while other readers wait.
- **Budget.** A full rebuild is one pass over the catalog. Its latency budget is set by a load test in this work, recorded with the ticket's evidence.
- **Unchanged:** Deck List format results still run the whole-deck check.

### Card type: one source

From the data contracts, section 3, and the [workspace reconciliation](wayfinder/research/reconcile-workspace-tickets.md), finding 1.

- **The source.** The effective card attributes are the only source of card type. Collection's category and type filters move onto them. The older metadata columns stay until a cleanup.
- **Trainer Type:** `supporter`, `item`, `tool`, `stadium`, or null when unknown.
  - It's derived from TCGdex `trainerType`, and any value the attribute rules don't name maps to null.
  - It's backfilled for the whole catalog, and correctable through the attribute review.
  - A Trainer with no Trainer Type matches the Trainer chips only through Any, and its tile shows no subtype.
- **Evolves from** is derived from TCGdex `evolveFrom` and backfilled. It isn't reviewed, and is used only to group Deck List lines.
- **One revision.** Attribute decisions advance the attribute revision, which feeds the Format Standing key.

### Deck List contracts

From the data contracts, sections 4, 5 and 8.

- **Display data.** Every line in the Deck read and in every Deck List command response carries name, set, collector number, Variant Descriptor, image URL, card kind, Trainer Type, evolves from and Card Identity.
- **Batch change:** `POST /api/decks/{id}/deck-list/changes`, with `revision`, `idempotency_key` and `changes: [{edition_id, quantity}]`.
  - `quantity` is the line's new total, and 0 removes the line.
  - It applies every change atomically, advances the revision once and returns the usual command result.
  - A swap is one batch.
  - Undo is the inverse batch at the new revision, and `STALE_DECK_LIST` is returned if the list changed in between.
  - The per-line routes stay.
- **Target Format:**
  - `target_format` on the Deck List: `standard`, `expanded` or `glc`, not null, defaulting to `standard`. A migration sets existing Deck Lists to Standard;
  - `PUT /api/decks/{id}/deck-list/target-format` takes `target_format`, `revision` and `idempotency_key`, is revision-checked, advances the revision and returns the command result with the new Format's result. It is not part of the Deck's Location edit;
  - the Deck read and command responses carry `target_format` and that Format's result only, and the format-checks read defaults to the Target Format.

### Batch add and Gather Undo

From the data contracts, sections 6 and 7, and the [workspace reconciliation](wayfinder/research/reconcile-workspace-tickets.md), finding 2.

- **Batch add:** `POST /api/holdings/batch`, with `location_id`, `idempotency_key` and `items: [{edition_id, quantity}]`, up to 200 Editions.
  - It runs in one transaction with one owner revision.
  - It writes one Undo record of a new **`add`** kind: the target Location and the copies added, with no sources. Undoing it removes exactly those copies, only if the Location still holds them all; otherwise `UNDO_INCOMPATIBLE`.
  - The newest-only rule and the five-record limit are unchanged.
  - The existing Undo list and toast read the new kind before batch add ships.
  - The single add route stays. Catalog's Add N cards, Collection's Add cards and the popup's Add all use batch add.
- **Gather.** Pick List confirmation moves to the multi-source Move path, writing one multi-source Undo record per confirmation. The five-source cap is removed.

### Publishing and public routes

From the data contracts, section 9, and [ADR 0011](../../adr/0011-publishing-needs-a-legal-target-format.md).

- **Publish gate.** Publish and republish recompute the Target Format result for today in the same transaction. Anything but `legal` is refused with `409 TARGET_FORMAT_NOT_LEGAL`, carrying the result. Snapshots store their Target Format, and existing snapshots migrate to Standard.
- **Price refresh.** Publish and republish start a background price refresh for the snapshot's Editions, within the existing admission caps.
- **Public format checks** for a snapshot version return its Target Format only.
- **Public cost** gains `editions: [{edition_ref, amount}]`, through the existing cache and admission caps, with no age.
- **Discover:**
  - summaries gain `target_format`, its result, and `cost: {amount, priced_copies, total_copies}`, with `amount` null when nothing is priced;
  - `format=` filters by Target Format;
  - the listing shows only Listed Published Decks whose snapshot is `legal` in its Target Format today. Each snapshot's result is cached by snapshot digest, rules sha256, evaluator code sha256, rule-date window and public format-fact revision, and recomputed when stale. An unconfirmable result leaves the deck out;
  - Discover reads cached quotes only and never admits a refresh.
- **Privacy.** No public route serves ownership or storage data. The browse route is never public.

### Supersedes

- **[Deck Lists and format validation spec](../deck-format-validation/spec.md):** this spec supersedes it where it says all three Formats are checked together and results never block publishing.
- **Delivered behaviour replaced** (from the [workspace reconciliation](wayfinder/research/reconcile-workspace-tickets.md)):
  - the `/workspace` route and name;
  - the workspace's own header and drawers;
  - leaving a page clearing the selection;
  - the Add cards dialog and its form;
  - Collection's Deck heading exports;
  - the Decks page's Holdings panel and Open in workspace link;
  - the old Collection page.

## Rollout

From [Decide rollout and verification](wayfinder/resolutions/decide-rollout-and-verification.md). The redesign is a launch gate. Pages move into the shell one at a time on `dev`. In-between states are acceptable because only the owner uses the app, and releases to `main` happen as usual. Data steps need no UI and can run alongside earlier UI stages.

1. **Foundations.** Tailwind and the kit. The shell with kept-mounted pages, routing and redirects, and existing pages mounted inside unchanged. On the kit: sign-in, loading, unavailable and not found (sign-in behaviour unchanged).
2. **Collection on the kit.** The rename and rewrite, the Variant Descriptor, the per-Leaf breakdown, and the old Collection page retired.
3. **Owner controls and Missing cards,** including the attributes and Reprint Groups queues. These come before stage 4, because Trainer Type must be correctable before the type chips depend on it.
4. **Catalog with Add mode.**
   - **Data first:**
     - Trainer Type and evolves-from derived and backfilled;
     - stored Format Standing and its rebuilds;
     - the browse route;
     - the `add` Undo kind, readable by the Undo list and toast.
   - **Ships together:** Catalog, the Add cards gallery over Collection (retiring the old dialog), and Collection's filters moving onto the attributes.
5. **Decks with the builder.**
   - **Data first:**
     - display data on lines;
     - the batch change command;
     - Gather's single Undo record;
     - Target Format, its command and the publish gate.
   - Collection's Deck banner links to the builder.
6. **Published Deck and Discover.**
   - **Data first:** the legal-only Discover listing with its filter and summary fields, and the public per-Edition cost.
7. **Last.** Delete the old global stylesheet once nothing uses it, and turn on the dark first paint.

**OAuth.** OAuth sign-in isn't blocked by this order. Its sign-in buttons, failure messages and Sign-ins page are built in the new look once stage 1 lands. If an OAuth ticket lands first, it builds on today's sign-in page and stage 1 restyles it.

## Testing Decisions

### What makes a good test

A good test checks what a collector, the owner or a caller can observe:

- a page's visible text, roles and focus;
- a route's status and body;
- a row's presence;
- an Undo that restores exactly what was changed.

It doesn't assert component names, CSS class names, Tailwind utilities or SQL. Tests go through the highest seam that shows the behaviour. Kit components are tested through the pages that use them, with no component-level unit tests.

### 1. The HTTP API (pytest)

These cover every backend contract in this spec. They run in the gate's pytest passes with the existing per-worker databases. Prior art: `test_deck_lists.py`, `test_multi_source_moves.py`, `test_inventory_undo.py`, `test_catalog_search.py`, `test_collection_holdings.py`, `test_card_category.py`, and the publication, discovery and published-cost tests.

- **Browse route:**
  - smart `q` (set plus number versus name, and empty);
  - each filter;
  - `format` hiding `not_legal` but keeping `unknown`;
  - ownership counts with and without `deck_id`;
  - keyset paging at 60;
  - a 409 when a cursor's revision or standing key changes;
  - signed-out refusal.
- **Format Standing:**
  - standings match the evaluator's per-line standing, including Reprint Group legality and a ban;
  - an import, an attribute decision and a rules change each rebuild the affected Format;
  - a stale key makes one reader rebuild while concurrent readers wait;
  - a rule-date crossing is picked up.
  - The full-rebuild latency is measured by a `slow` test with a recorded budget.
- **Card attributes:**
  - Trainer Type and evolves-from derivation and backfill, with an unnamed source value mapping to null;
  - a reviewed Trainer Type correction changes the browse route's `kind` filter, Collection's filter and the format result together.
- **Deck List:**
  - display data on every line, unowned lines included;
  - the batch command is atomic, advances the revision once and is idempotent;
  - a swap and its inverse restore the list;
  - an inverse batch after another edit returns `STALE_DECK_LIST`;
  - the Target Format command is revision-checked and returns the new result;
  - the migration defaults existing lists to Standard.
- **Batch add:**
  - up to 200 Editions in one transaction;
  - one `add` Undo record that removes exactly the added copies, and `UNDO_INCOMPATIBLE` after one moves;
  - the five-record limit is kept;
  - idempotency.
- **Gather:**
  - a confirmation from more than five sources writes one multi-source Undo record and leaves Collection's earlier Undo records in place.
- **Publishing and public:**
  - publish and republish refused with `TARGET_FORMAT_NOT_LEGAL` for `not_legal` and `unknown`;
  - the snapshot stores its Target Format;
  - public format checks return the Target Format only;
  - public cost carries per-Edition amounts and no age;
  - Discover lists only snapshots legal today, drops one that stops being legal and restores it when legal again, filters by `format`, carries the cost fields and never admits a refresh;
  - **privacy:** no public response contains ownership or storage fields.

### 2. The browser (Playwright, full stack)

Each page and the shell get specs against the per-worker stacks. Prior art: `workspace-accessibility.spec.ts` (axe at WCAG 2.2 AA, focus, 44 px targets, reduced motion), `workspace-selection.spec.ts`, `workspace-actions.spec.ts`, `workspace-gallery.spec.ts`, `mobile-journey.spec.ts`, `decks.spec.ts`, `discovery.spec.ts` and the published-deck specs.

- **One shared page-check helper** in the browser test support folder replaces the axe and target checks that specs copy today. Given a page state, it runs:
  - axe at WCAG 2.2 AA;
  - no page-level horizontal scroll;
  - every visible interactive element at least 44 px tall, or with a 44 px tap area, at 375×812.
- **Every page** runs the helper at 1280×800 and 375×812, on its main states, with its dialogs and sheets open as well as closed.
- **Shell:**
  - the tabs, avatar menu, More sheet and ☰ drawer;
  - switching tabs and back keeps Location, selection, scroll and filters, with no placeholder tile appearing and no size change, which covers #121;
  - a reload starts fresh;
  - `/`, `/workspace` and `/locations` land on `/collection`;
  - Escape and focus return for every Dialog.
- **Collection:**
  - the Variant on tiles and in accessible names, with Names on and off;
  - the inspector's Variant row and per-Leaf breakdown;
  - Add cards opening Catalog in Add mode, adding several cards and undoing them in one step;
  - the Deck banner.
- **Decks:**
  - add by drag and by tap;
  - rapid ±1 taps all landing in order;
  - swap and its Undo;
  - "Can't undo: this deck changed";
  - the three views and copy states;
  - surplus Put away;
  - the Target Format control and the results dialog;
  - Publish disabled with its reason, and enabled when legal;
  - Gather from more than five sources with one Undo;
  - Buy missing defaulting to not owned;
  - Delete with a typed name;
  - the phone Deck and Library tabs.
- **Catalog:**
  - smart search modes;
  - filters, including an unknown-standing card kept with "?";
  - popup stepping;
  - Add to Collection;
  - Add mode queue, Add N cards and Undo;
  - the status line states.
- **Published Deck and Discover:**
  - signed out under the public header and signed in inside the shell;
  - per-card and per-line prices;
  - the owner bar states;
  - Discover's legal-only listing, format chips and the three cost states.
- **Missing cards and Owner controls:**
  - each sub-tab;
  - the inline review card staying pinned while the table scrolls sideways at 375 px;
  - reason-only Request information and Reject;
  - the code step on every other decision;
  - the attributes queue correcting a Trainer Type;
  - a Reprint Groups move.
- **Sign-in and Sign-ins:**
  - one, two and three providers (the third generic);
  - email form off by default and on;
  - each message group arriving by `?error=`, focused once, placed before the buttons, with `error` and `error_description` removed and provider free text never shown;
  - the Sign-ins page showing Remove only with more than one connection.
- **First paint:** the served HTML, rendered with scripts disabled, has the dark background and the wordmark.
- **Existing specs** move to the new selectors and routes when their page changes, and aren't deleted. Specs that still enter through `/locations` assert the redirect instead.

### Running

Follow `docs/agents/verification.md`. Iterate with the narrow API and browser loops. Each ticket is accepted on the tests relevant to it, through the narrow loops, and its evidence quotes their counts. The full gate runs once, after the last ticket and before the pull request to `dev`, and the pull request quotes the counts from its `verification.log`. Tests that measure elapsed time are marked `serial`, and tests that start real processes or build capacity-sized data are marked `slow`, each with a reason.

### Owner walkthroughs

Each page gets a 5–10 step checklist in the launch checklist, for the owner to run on a phone and a desktop. Code merges to `dev` on the automated checks. The launch needs every walkthrough ticked.

## Out of Scope

- Packaging as an Electron or other desktop app. The shell only keeps that door open.
- User-chosen themes and a light theme.
- New features beyond the Deck List UI, the two Owner controls review queues and the batch add.
- Renaming code identifiers from "workspace" to "collection".
- **Minimum Deck Cost:** a deck's cost with every card in its cheapest playable version. Saved for later.
- Multi-step Undo in the deck builder. It can be added later without changing these contracts.
- OAuth sign-in behaviour: provider configuration, the gate, linking and limits belong to the [OAuth spec](https://github.com/ry-cen/prizecheck/issues/147). This spec fixes only its screens' layout and wording.
- Removing `GET /api/collection`, `GET /api/catalog/search` and the older card metadata columns. They lose callers here, and removing them is follow-on cleanup.
- A collector-number filter in Collection.

## Further Notes

- **The terms and privacy line** on the sign-in card points at pages that don't exist yet. It ships without links, as plain text, until those pages exist.
- **Ticket grouping.** Implementation tickets are grouped by the seven rollout stages. Each stage's data tickets block its page tickets. Stage 3 blocks stage 4's type chips. Stage 7 waits for every page.
- **CONTEXT.md** already defines Format Standing, Trainer Type and Target Format. No new terms are introduced here.
- **Prototypes** are on throwaway branches for reference only, and are never merged:
  - `prototype/app-shell`;
  - `prototype/deck-experience`;
  - `prototype/catalog-search`;
  - `prototype/owner-missing`;
  - `prototype/sign-in`.

  Their notes are under `wayfinder/prototypes/`.
- **Map ticket links** point at `feature/app-redesign`. When it merges to `dev`, repoint them.
