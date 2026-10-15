# Spec — Collection import from other trackers

**Status:** ready for tickets, 2026-10-15

**Decision map:** [Collection import — decision map](wayfinder/map.md). All six tickets are closed: five resolved, and the limits ticket merged into the contract. Nothing is left unspecified. Each section below names the decision it comes from:

- [Research collection export formats from other trackers](wayfinder/research/tracker-export-formats.md)
- [Decide what the import accepts](wayfinder/resolutions/decide-what-the-import-accepts.md)
- [Decide how imported rows match Card Editions](wayfinder/resolutions/decide-how-rows-match.md)
- [Prototype the collection import review](wayfinder/resolutions/prototype-collection-import-review.md) ([prototype](wayfinder/prototypes/import-review/README.md))
- [Decide the collection import contract](wayfinder/resolutions/decide-collection-import-contract.md), with the limits ticket merged in
- [ADR 0014: Collection import from other trackers is in scope](../../adr/0014-collection-import-in-scope.md)

## Problem Statement

A collector who already tracks their cards in another app can't bring them into PrizeCheck, except by adding hundreds or thousands of cards one at a time. These apps include the TCGplayer app, Collectr, PriceCharting, TCG Collector, Dragon Shield and Sorted. Retyping a collection is the biggest reason not to switch, and it matters most once signup is public. Those trackers' exports don't line up with our catalog either:

- They name sets in their own words.
- They mix in watchlist entries, sealed product, other games and non-English cards.
- They write finishes in their own vocabulary.
- They repeat rows, one per copy.

## Solution

A **Collection Import** lets a collector upload a tracker's export file, or paste a list, and review every row before anything is added:

- **Where it starts:** the Collection header has **Import…**, and an empty Collection offers **Import from another tracker**. The collector chooses one Storage Leaf to receive the cards, Unsorted by default.
- **Reading the file:** PrizeCheck recognises the file without being told which tracker it came from, matches each row to a Card Edition, and leaves out rows it can't hold, saying how many and why.
- **The review:** one list that opens on the rows that need the collector. They can fix rows one at a time, or set a finish or skip rows in bulk. A file's groups (portfolios, folders, lists) can be left out.
- **Saving:** adds every remaining copy in one step and lands on that Location.

An import only adds copies. It never changes or removes what's already there, and there's no undo, because the review is the safety net.

## User Stories

### Starting an import

1. As a collector, I want an **Import…** action in my Collection's header, so that I can bring cards over from another tracker at any time.
2. As a new collector with an empty Collection, I want the empty state to offer **Import from another tracker**, so that moving in is the obvious first step.
3. As a collector, I want to upload my tracker's export file, so that I don't retype my collection.
4. As a collector, I want to paste a list instead, so that I can import rows copied from a spreadsheet or cards typed one per line.
5. As a collector, I want the upload to accept CSV, TSV and TXT files, and a zip holding one of them, so that a PriceCharting export works without unzipping first.
6. As a collector, I want to choose one Location for every imported card, Unsorted by default, so that I know exactly where the new cards land.
7. As a collector, I want to be told before uploading that PrizeCheck keeps each card, its finish and how many I have, but not condition, prices paid or notes, so that I'm not surprised later.
8. As a collector, I want short how-to-export steps for each supported tracker, so that I can find the right file.
9. As a collector whose collection is over 10,000 rows or 5 MB, I want a clear message saying so and suggesting I split it in two, so that I know how to proceed.
10. As a collector, I want a file from any of the six supported trackers recognised without choosing a tracker, so that importing is one step.
11. As a collector with a CSV from another app, I want it read when its columns look like name, set, number, quantity and finish, so that I'm not limited to six trackers.
12. As a collector whose CSV can't be read, I want to be told which tracker files work, so that I can export again.
13. As a collector who pastes rows with a header copied from a spreadsheet, I want them read like a file, so that copying a sheet works.
14. As a collector who pastes lines like `3 Pikachu SVI 25` or `2x Iono PAL 185`, I want them read the way decklist import reads them, so that familiar shorthand works.
15. As a collector who pastes a line with only a name, or a name and set, I want it matched by name where possible and otherwise sent to me to resolve, so that free text isn't wasted.
16. As a collector whose file was saved from Excel, I want accented names such as Pokémon read correctly, so that rows aren't garbled.
17. As a collector who abandons an import, I want to come back within a day and continue where I left off, so that a large review isn't lost.
18. As a collector who starts a new import while one is open, I want to be asked before the open one is replaced, so that I don't lose fixes by accident.

### Matching rows

19. As a TCGplayer app user, I want my rows matched by their TCGplayer product, so that the right card and finish come through.
20. As a Collectr, TCG Collector, PriceCharting, Dragon Shield or Sorted user, I want my rows matched by set and collector number, so that most rows need nothing from me.
21. As a collector, I want numbers like `042/102`, `TG01/TG30` and `040 / 096` understood, so that denominators and spacing don't break matching.
22. As a collector, I want promo, Energy and catch-all sets recognised under the names my tracker uses, so that those rows match too.
23. As a collector, I want Basic Energy rows without a number matched by Energy type, so that bulk Energy imports cleanly.
24. As a collector, I want a row whose number fails matched by name, but only when its set holds exactly one card with that name, so that a Printing is never guessed.
25. As a collector, I want a row whose set holds several cards with that name shown as **Pick one** with the candidates, so that I decide.
26. As a collector, I want a row that matches nothing shown as **Not found**, with a catalog search, so that I can find the card or skip it.
27. As a collector, I want a row with no readable number or name shown as **Can't read**, so that I know it needs me.
28. As a collector, I want finish words like Reverse Holo, Cosmos Holo, 1st Edition and stamps, from a finish column or the card name, mapped to the right Card Edition, so that my variants come through.
29. As a collector, I want a row whose finish is unclear matched to the card's Unspecified Variant and marked **Finish unknown**, so that it doesn't stop the import and I can fix it now or later.
30. As a collector, I want a card with only one Edition matched to it whatever finish my tracker wrote, so that I'm not asked a pointless question.
31. As a collector, I want rows for the same Card Edition added together, so that PriceCharting's one row per copy and TCG Collector's repeated rows give the right counts.
32. As a collector with graded slabs, I want them imported as ordinary copies of their Card Edition, so that they're in my Collection even though grades aren't tracked.
33. As a collector, I want watchlist rows, sealed product, other games and non-English cards left out automatically, so that they don't clutter the review.
34. As a collector, I want a summary of what was left out and why, with counts, so that nothing disappears without my knowing.
35. As a collector, I want to view and download the left-out rows, so that I can keep them for another app.
36. As a collector, I want condition, price paid, purchase date and notes ignored quietly, so that the review stays about cards.
37. As a collector whose card isn't in the catalog yet, I want the row to wait for me rather than be dropped silently, so that I can skip it knowingly.

### Reviewing

38. As a collector, I want the review to open on **Needs you** whenever rows need me, so that I start with what blocks saving.
39. As a collector, I want filters for **Needs you**, **Finish unknown**, **Matched by name**, **All** and **Skipped**, each with a count, so that I can work through a big file in passes.
40. As a collector, I want each row to show the quantity, the matched card, its set and number, its group and my source row, so that I can check the match against my file.
41. As a collector, I want each row to say how many copies I already have, so that I can spot an accidental second import.
42. As a collector, I want a summary of how many incoming cards are already in my Collection, with a note that importing adds to them, so that I understand an import is additive.
43. As a collector, I want to fix a flagged row inline with candidates and a catalog search, so that I don't leave the review.
44. As a collector, I want to skip a row and restore it later, so that a mistaken skip isn't permanent before saving.
45. As a collector, I want to select rows, or all rows in the current filter, and set a finish or skip them at once, so that thousands of rows don't mean thousands of clicks.
46. As a collector, I want a bulk finish to apply only where the card has that finish, and to tell me which rows it couldn't apply to, so that no card gets an Edition that doesn't exist.
47. As a collector, I want **Skip all** on Needs you, so that I can import everything readable now and deal with the rest later.
48. As a collector, I want to pick each row's finish from the card's own Editions, so that I choose only real variants.
49. As a collector, I want my file's groups (Collectr portfolios, PriceCharting folders, Sorted lists) listed with row counts and all included, so that I can untick a group like "Sold" or "For trade".
50. As a collector, I want to change the destination Location during the review, so that I can change my mind before saving.
51. As a collector, I want totals for cards to add, rows needing me, finish unknown and skipped, so that I know where I stand.
52. As a collector, I want long reviews to load in pages, so that a 3,000-row file stays responsive.
53. As a collector, I want the review never to name the tracker my file came from, so that the screen shows only what helps me decide.
54. As a collector, I want the review to show no prices, so that importing doesn't wait on price checks.

### Saving

55. As a collector, I want saving disabled until every Needs-you row is fixed or skipped, with the count of what's left, so that nothing half-matched is added.
56. As a collector, I want Finish unknown rows never to block saving, so that a large file isn't held up by finishes.
57. As a collector, I want to download my skipped rows in my file's own columns, so that I can fix them elsewhere or import them later.
58. As a collector, I want one **Add N cards to <Location>** action that adds everything in one step, so that a failure never leaves half an import.
59. As a collector, I want to land on the chosen Location afterwards, with a toast saying how many cards were added, so that I see the result right away.
60. As a collector who double-clicks Save or retries after a network error, I want the cards added only once, so that there's no undo to need.
61. As a collector whose destination Location was moved, converted or deleted during the review, I want saving refused and the review refreshed, so that cards don't land somewhere unexpected.
62. As a collector whose matched card was withdrawn from the catalog during the review, I want that row returned to Needs you, so that I can choose again.
63. As a collector, I want imported copies to be ordinary Holdings I can move, remove or sort like any other, so that the import leaves no special state.
64. As a collector, I want prices for my new cards to load as I browse, like any other card, so that importing doesn't trigger a flood of price checks.

### Phone and accessibility

65. As a collector on a phone, I want the import screen and the review with no horizontal scroll, the side column stacked above the list, and 44 px controls, so that I can import on my phone.
66. As a collector using a screen reader, I want row statuses, filter chips, selection and the disabled Save to have names and states that are announced, so that the review is usable without sight.
67. As a keyboard user, I want focus to move into a resolver when I open it and back when I close it, so that fixing rows works without a mouse.

### Operations and safety

68. As the owner, I want one import capped at 10,000 rows and 5 MB, counted after unzipping, so that one request can't exhaust the API.
69. As the owner, I want only the import's upload route to accept bodies up to 5 MB, so that every other route keeps its tight limit.
70. As the owner, I want zip uploads limited to one entry, no encryption, no nesting and 5 MB uncompressed, so that a zip bomb can't take down the server.
71. As the owner, I want each collector limited to 20 imports started per day, so that public signup can't be used to hammer matching.
72. As the owner, I want an import never to start a catalog pull, so that pulls stay owner-only.
73. As the owner, I want a draft's raw rows deleted when it's saved or expires, so that we don't keep other apps' exports longer than needed.

## Implementation Decisions

### Terms

- **Collection Import** is now in `CONTEXT.md`. Use it, and never "catalog import" or "sync", for this feature. **Decklist Import** is a different feature.
- **Import draft** is the server-held review. It's an implementation term and isn't in the glossary.

### Reading the input ([what the import accepts](wayfinder/resolutions/decide-what-the-import-accepts.md))

- **A pure reading module** turns bytes or pasted text into source rows. Each row has a row number, its group (or none), its raw text, and named fields: name, set name, set code, number, quantity, finish words, language, product ID, plus the category, watchlist and grade flags.
- **Header presets** cover the TCGplayer app (12 and 14 columns), Collectr (14 and 16 columns, with the dated price column matched by prefix), PriceCharting, TCG Collector, Dragon Shield (after its leading `"sep=,"` line) and Sorted. A recognised header always wins.
- **The loose fallback** maps any other CSV by column names that look like name, set, number, quantity, finish and product ID. If there aren't enough of them, the file is refused with the list of supported trackers.
  - TCGplayer's previous-app `legacy_data.csv` and Dex+ exports go through the fallback until a real file confirms their headers.
- **Paste:**
  - a recognised header on the first line (comma or tab separated) is read like a file;
  - otherwise each line goes through decklist import's line grammar;
  - lines that grammar can't read go to the name fallback.

  TCGplayer's plain-text email export goes through this path.
- **Decoding:** UTF-8 with the BOM dropped, falling back to Windows-1252. Standard CSV quoting, LF or CRLF. Decklist import's normalisation applies to every cell: NBSP, zero-width spaces, NFC and curly apostrophes.
- **Detection is silent.** The detected tracker is stored with the draft for matching only. No response field meant for the UI names it.

### Matching ([how rows match](wayfinder/resolutions/decide-how-rows-match.md))

- **Filters run first, and each left-out row records its reason:**
  - **watchlist:** Collectr's watchlist flag;
  - **sealed:** a blank number with a blank rarity, or a sealed product name;
  - **other games:** a non-Pokémon category, console or collection;
  - **non-English:** a language column, `(JP)` or `(CN)` tags, a Japanese or Chinese PriceCharting console, or Dragon Shield sets that exist only in Japan.

  Graded rows aren't filtered.
- **Matching order.** The first step that answers wins:
  1. **TCGplayer product ID.** It resolves to a Printing through a verified Marketplace Mapping, or else through TCGdex's TCGplayer ID kept in the catalog generation. The printing or finish column then picks the Edition.
  2. **Set and number.**
     - **The set** resolves through the new collection set-name alias table, then naive normalisation (lowercase, punctuation stripped, prefixes like `SV01:` and `SM -` removed). Dragon Shield and Sorted codes try the printed set-code table first.
     - **The number** loses any denominator, then gets the alias table's number rules (`037/DP-P`, `012VL`, PriceCharting's `#SWSH138` inside the name), and is compared with catalog search's number key.
  3. **Basic Energy by type,** for Energy rows with no usable number, as decklist import does.
  4. **Name within the row's set,** with decklist import's name normalisation and optional parenthetical subtitles. One candidate gives **Matched by name**. Several, or no set, give **Pick one** with candidates.
  5. Otherwise **Not found**. A row with no readable number and no usable name is **Can't read**.
- **Collection set-name alias table.** A new checked-in table, separate from decklist import's alias table, keyed by tracker and set name and pointing to a TCGdex set ID. Every row cites the export or source that shows it. It holds only what naive normalisation misses: promo, catch-all and Energy sets.
- **Finish table.** One mapping per tracker, from its finish column values and name tags to a Variant Descriptor. A card with one Edition always gets it. A finish that is unmapped or blank, on a card with several Editions, matches the Unspecified Variant and is marked **Finish unknown**.
- **Quantities:**
  - a blank quantity on a non-watchlist row counts as 1;
  - a zero or non-integer quantity is **Can't read**;
  - rows resolving to the same Card Edition are summed at save time.
- **No catalog pulls.** Matching never starts a catalog pull, and a card missing from the catalog stays Not found.
- **One module** owns filtering, matching and finish choice. It takes source rows and a catalog view and returns a status, Printing, Edition, candidates and reason for each row. Decklist import's parser, number key and name normalisation are reused, not copied.

### The import draft ([contract](wayfinder/resolutions/decide-collection-import-contract.md))

- **Schema.** A draft table: owner, status (open or saved), landing Location, excluded groups, detected source, `draft_revision`, `catalog_revision`, and created, changed, expires and saved times. A child table of draft rows: row number, group, raw text, parsed fields, status, Printing, Edition, candidates, left-out reason, skipped flag and the collector's fix.
- **One open draft per collector.** Starting another replaces it. The UI confirms first, and the API simply replaces.
- **Expiry.** An open draft expires 24 hours after its last change. Saved and expired drafts lose their rows. A small receipt (counts and the save result) is kept for 24 hours to replay saves.
- **The 10,000-row cap** counts every source row, including left-out rows.

### API

All routes are for the signed-in owner only, with base-10 string quantities as elsewhere.

- **Start:** `POST /api/collection-imports`. The body is a file upload or `{ text }`, plus `location_id`.
  - It parses and matches in the request, with batched catalog lookups, and returns the draft summary.
  - **Refusals:**
    - 422 `IMPORT_TOO_LARGE` (over 5 MB, raw or unzipped);
    - 422 `IMPORT_TOO_MANY_ROWS`;
    - 422 `IMPORT_UNREADABLE`, listing the supported trackers;
    - 422 `IMPORT_BAD_ZIP` (several entries, encrypted, nested, or a wrong extension);
    - 422 when the Location isn't the collector's Storage Leaf;
    - 429 `IMPORT_RATE_LIMITED` after 20 starts in a day.
- **Summary:** `GET /api/collection-imports/current` returns 404 when no draft is open. Otherwise it returns:
  - the counts per status, cards to add, groups with their row counts and whether each is included, and left-out counts by reason;
  - how many incoming cards are already held, and the landing Location;
  - `draft_revision` and the expiry time.
- **Rows:** `GET /api/collection-imports/{id}/rows?filter=needs|finish|name|all|skipped&cursor=` returns pages of 100. Each row has its number, group, raw text, quantity, status, card, Edition, the card's active Editions (for the finish picker), candidates and copies already held.
- **Changes:** `POST /api/collection-imports/{id}/changes` takes `{ draft_revision, changes }`, applied in order in one transaction. Each change is one of:
  - `{ rows | filter, pick }`, with a Printing or Edition;
  - `{ rows | filter, finish }`, with a Variant Descriptor; rows whose card lacks it are reported back unchanged;
  - `{ rows | filter, skip | restore }`;
  - `{ group, include }`;
  - `{ location_id }`.

  It returns the new summary and revision. A stale revision returns 409 `STALE_DRAFT`.
- **Downloads:** `GET /api/collection-imports/{id}/skipped.csv` and `.../left-out.csv` return the rows in the source's own header and columns. A paste comes back as its lines.
- **Save:** `POST /api/collection-imports/{id}/save` takes `{ draft_revision, idempotency_key }`. In one transaction it adds one Holding increment per resolved Card Edition to the landing Storage Leaf and advances the owner revision once.
  - **Refusals:**
    - 422 `ROWS_NEED_YOU`;
    - 409 `REVIEW_CHANGED` when the Location is no longer the collector's Storage Leaf, or an Edition is no longer active (those rows return to Needs you).
  - **Replays:** a repeated idempotency key, or a second save of a saved draft, returns the first result and writes nothing.
  - **Undo:** none, and no undo id is returned.
  - **The 200-item batch limit** for other add paths is unchanged and doesn't apply here.
- **Prices:** none of these routes read or refresh prices. After saving, Collection tiles request prices near the viewport as they already do (ADR 0006, ADR 0013).

### Gateway and proxy

- **The start route alone** accepts bodies up to 5 MB, through the gateway's existing per-route body limits (as decklist import's 64 KiB routes do). The proxy's body size is raised for that location only. Every other route keeps its limit.
- **Unzipping** happens in the API as a stream: one entry with a permitted extension, no encryption, no nesting, and it stops at 5 MB uncompressed.

### Web

- **The Collection** gets **Import…** in its header, and the empty Collection gets **Import from another tracker**.
- **The import screen:**
  - **Upload a file** or **Paste**;
  - **Put cards in**, a Storage Leaf picker defaulting to Unsorted;
  - the "PrizeCheck keeps…" line;
  - a collapsed **How do I export from my tracker?** with steps for each of the six trackers.

  If a draft is open, the screen offers to continue it, or to replace it after confirming.
- **The review:**
  - stats;
  - one list with the five filter chips, opening on Needs you;
  - inline resolvers;
  - row selection with **Select all** in the current filter, **Set finish…** and **Skip**, and **Skip all N** on Needs you;
  - the side column (**Put cards in**, **In this file** groups, **Left out** with View and Download, the "already in your Collection" note), sticky on desktop and stacked on phones;
  - a save bar with **Add N cards to <Location>**, disabled with "N rows need you", and **Download skipped rows** once any are skipped.

  The prototype is the reference for layout. Build it on the app's components and tokens, not the prototype's markup.
- **After saving,** the collector lands on the chosen Location with a confirmation toast that has no Undo.
- **Copy** never names a tracker or the data source, and shows no prices or fetch times (AGENTS.md).

## Testing Decisions

### What makes a good test

A good test checks what a collector or caller can observe:

- a route's status and body;
- Holdings after saving;
- a downloaded CSV's rows;
- a page's visible text, roles and focus.

It doesn't assert module names, SQL, CSS classes or component structure. The owner confirmed three seams, all already in the repository.

### 1. The HTTP API (pytest, signed HTTP against PostgreSQL)

Prior art: the batch-add, holdings, collection-holdings, missing-cards and deck-list-changes tests, and decklist import's review and create tests on `feature/decklist-import`.

- **Reading, through the start route.** There are no reader unit tests. Each research fixture is posted against a seeded test catalog, and its statuses, groups and left-out reasons are asserted. The fixtures are the TCGplayer app, both Collectr headers, PriceCharting, TCG Collector, Dragon Shield and Sorted, plus the legacy and paste reconstructions. Cases:
  - `"sep=,"`;
  - CRLF;
  - a BOM;
  - Windows-1252 text;
  - a tab-separated paste;
  - decklist-style lines;
  - free-text lines;
  - an unrecognised CSV read by the fallback;
  - an unreadable file refused with the tracker list;
  - a zip with one entry, and zips that are refused (several entries, nested, encrypted, a wrong extension, over 5 MB uncompressed);
  - the 10,000-row and 5 MB limits.
- **Matching:**
  - TCGplayer product ID through a mapping and through TCGdex's ID;
  - set name plus number, with each denominator shape;
  - every alias table row;
  - Basic Energy by type;
  - a name with one card in its set, several, and no set;
  - Not found;
  - Can't read;
  - the finish table per tracker, including name tags;
  - Finish unknown, and the single-Edition shortcut;
  - graded rows kept;
  - each filter reason;
  - repeated rows summed.
- **Changes:**
  - pick, finish (including the rows it couldn't apply to), skip and restore, by rows and by filter;
  - leaving a group out and back in;
  - changing the Location;
  - `STALE_DRAFT`.
- **Downloads:** skipped and left-out rows come back in the source's own header and columns.
- **Save:**
  - Holdings added per Edition, with summed quantities, to the landing leaf, and one owner revision;
  - `ROWS_NEED_YOU`;
  - `REVIEW_CHANGED` for a deleted or converted Location and for a withdrawn Edition;
  - idempotent replay, and a second save of a saved draft writing nothing;
  - no undo id;
  - raw rows deleted.
- **Drafts:** one open per collector, with replacement; expiry after 24 hours; another collector gets 404.
- **Bounds:**
  - the daily rate limit;
  - no catalog pull started;
  - no price runner launched and no quote read during start, changes or save.
- **Budget:** 10,000 fixture rows parse and match within 10 seconds in CI. If not, the work moves to a detached job behind the same interface.

### 2. The gateway (its existing route tests)

Prior art: the gateway's tests for decklist import's 64 KiB body limit.

- The start route accepts up to 5 MB and refuses more with 413.
- Every other route keeps its limit, including decklist import's 64 KiB routes.

### 3. The browser (Playwright on per-worker stacks)

Prior art: the workspace, batch-add, mobile-journey and accessibility specs, and decklist import's review specs on `feature/decklist-import`. Each test starts as a new owner.

- **The happy path:** from the empty Collection, upload a fixture file. The review opens on Needs you. Pick one row, search for a Not found row, skip a Can't read row, then save. The collector lands on Unsorted with the toast, and the cards are there.
- **Bulk:** **Select all** in Finish unknown, then **Set finish…**. **Skip all** on Needs you enables Save.
- **Groups and Location:** untick a group and the counts drop; change the destination and the cards land there.
- **Left out:** the summary counts, View, and Download.
- **Resume:** reload mid-review and continue the open draft. Starting a new import asks before replacing it.
- **Paste:** a mixed paste reads spreadsheet rows, decklist lines and free text.
- **Phone width:** no horizontal scroll on the import screen or the review, the side column above the list, and 44 px controls.
- **Accessibility:** statuses, chips, selection and the disabled Save are announced, and focus moves into and out of resolvers.

## Out of Scope

- Exporting the Collection as CSV or text.
- Ongoing sync or reconciliation with another tracker, and any link back to its rows.
- Undoing an import after saving.
- Tracking condition, grade, price paid, purchase date or notes.
- Importing Decks or Deck Lists from tracker files (decklist import covers Decks).
- Splitting one import across several Locations, or turning a file's groups into Locations.
- Non-English cards, sealed product and other games.
- Collector-started catalog pulls for cards missing from the catalog.
- Excel files.
- The selection subtotal with coverage, a separate effort shelved on 2026-10-15.

## Further Notes

- **Depends on decklist import.** The reader and matcher reuse its line grammar, normalisation, number key and name fallback, from `feature/decklist-import` (spec [#205](https://github.com/ry-cen/prizecheck/issues/205)). Implementation tickets that reuse them start after that work reaches `dev`.
- **Fixtures.** Seven of the research fixtures are short slices of exports people committed to public GitHub repositories. Their licences weren't checked, and each is pinned to its source in the research. Before they're copied into test fixtures, either confirm their licences or replace them with reconstructions that keep the same edge cases.
- **Launch evidence.** Before public signup, import one real export from each of the six trackers, kept outside the repository, on a deployed stack, and record each file's row counts per status in the launch checklist.
- **Unconfirmed formats.** Dex+ columns, TCGplayer's legacy header and its plain-text export are read only through the fallback and paste paths. When a real file confirms one, it gets a preset.
- **Branch.** Work goes on `feature/collection-import`, cut from `dev`. Tickets close on the release to `main`, as with other features.
