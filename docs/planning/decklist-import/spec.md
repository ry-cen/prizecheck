# Spec — Decklist import and the Want List

**Status:** ready for tickets, 2026-10-14

**Decision map:** [Decklist import and Want List — decision map](wayfinder/map.md). All six tickets are resolved and nothing is left unspecified. Each section below names the resolution it comes from:

- [Decide the import and Want List behaviour](wayfinder/resolutions/decide-import-and-want-list-behaviour.md)
- [Research decklist text formats](wayfinder/research/decklist-text-formats.md)
- [Research how set codes map to the catalog](wayfinder/research/set-code-mapping.md)
- [Prototype the Want List page](wayfinder/resolutions/prototype-want-list.md)
- [Decide the Want List contract](wayfinder/resolutions/decide-want-list-contract.md)
- [Prototype the import review step](wayfinder/resolutions/prototype-import-review.md)
- [Decide the import contract](wayfinder/resolutions/decide-import-contract.md)

This spec reverses the "Pasted or imported decklists from outside the app" exclusion in the [Deck Lists and format validation spec](../deck-format-validation/spec.md).

## Problem Statement

A collector who wants to build a Deck almost always starts from a list someone else made: a tournament list on Limitless, a TCG Live export from a friend, a list pasted under a YouTube video, or a Published Deck on Discover. Today they have to rebuild that list card by card in the deck builder: search each card, pick a Printing, set a quantity, sixty cards at a time. They can't:

- paste a list and get a Deck List from it;
- update an existing Deck to a newer version of a list without editing every line by hand;
- copy a Published Deck into their own Decks;
- reuse the cards they already own when they build from someone else's list. A list names one Printing, and the collector may own the same card in another Printing.

Once they have several Decks, they can't see what they still need to buy across all of them. Each Deck's builder shows "to complete" on its own, and those figures count copies sleeved in other Decks as owned. Two Decks that both need the same card each look complete when the collector owns only one set of copies. There is no single list to shop from, and no way to tell which Deck a purchase is for.

## Solution

**Decklist Import.** A collector pastes a list from Pokémon TCG Live or Limitless, or copies a Published Deck, and checks every line in a review before anything is saved.

- **Where it starts:**
  - Decks has **Import a list**, which creates a new Deck.
  - A Deck's builder has **Replace list…**, which replaces that Deck's Deck List.
  - A Published Deck has **Copy to my Decks**, which creates a new Deck.
- **The review is one list, by section.** Each line shows what it matched, which owned copies it uses ("Used 1 Iono PAL 254 you own"), and what it becomes in the Deck List.
- **Lines that need the collector** are flagged and listed first. A collector picks between cards with the same name, searches for a card that wasn't found, reports a card missing from the catalog, or drops the line.
- **Save** is possible once every line is resolved. Saving lands in the Deck's builder with Undo.
- **Owned cards.** One setting decides how owned cards are used:
  - **Exact printings:** owned copies of the named Printing only;
  - **Use cards I own:** owned copies of any Printing of the same card.

  Either way, the rest of each line gets the cheapest priced Edition.
- **Replace** shows which held cards will become Surplus. They stay in the Deck until the collector puts them away.

**The Want List** shows what a collector's Decks still need from outside the Collection.

- **Where it lives:** it is a view inside Decks, beside My Decks.
- **What it shows:** one section per Deck, a combined total, and what everything costs. It exports to TCGplayer Mass Entry.
- **Counting setting:** **Every Deck built at once** (the default) gives each spare copy to one Deck only, oldest Deck first. **One Deck at a time** counts every copy for every Deck.
- **One number everywhere.** A Deck's need is the same on its Want List section, its Decks card, the builder's "to complete" and Buy missing.
- **Swap.** When a line needs a card the collector owns in another playable Printing, **Swap** changes that many copies of the line to the owned Printing.
- **Settings.** The counting setting lives on a new Settings page, which replaces Sign-ins.

## User Stories

### Pasting a list

1. As a collector, I want an **Import a list** button beside Create Deck on Decks, so that I can start a Deck from a list I found.
2. As a collector, I want to paste a TCG Live export exactly as the game copies it, so that I don't have to clean it up first.
3. As a collector, I want to paste a Limitless deck page's Copy to Clipboard text, so that tournament lists import directly.
4. As a collector, I want a list pasted from a YouTube description or a forum post to work even with a title, links and other text around it, so that I don't have to cut it out by hand.
5. As a collector, I want section headers and "Total Cards" lines to be accepted but not trusted, so that TCG Live's line counts and Limitless's card counts both work.
6. As a collector, I want a live count of card lines and cards as I paste, so that I can see the paste was read before I review it.
7. As a collector, I want lines that aren't cards to be ignored, listed where I can check them, so that prose never blocks an import.
8. As a collector, I want to name the new Deck before reviewing, so that it's saved under the name I chose.
9. As a collector, I want to choose the new Deck's Target Format on the paste screen, starting on Standard, so that the builder's format check runs against the Format I meant.
10. As a collector, I want German TCG Live headers (`Energie:`, `Karten insgesamt:`) to work, so that a list from a German player imports.
11. As a collector, I want curly apostrophes, odd spaces and Windows line endings in a paste to be handled, so that copying from a website doesn't break lines.
12. As a collector, I want a paste that's far too long, or has more lines than a Deck can hold, to be refused with a clear message, so that I know what went wrong.

### Matching

13. As a collector, I want each line's set code and number to find the exact Printing it names, so that the Deck List matches the list I pasted.
14. As a collector, I want Limitless's rewritten codes to work: promos as `PR-SV` and `PR-SW`, Trainer Gallery as `BRS-TG 5`, Shining Vault's flat numbers, and Basic Energy as `Energy 31`. That way, tournament lists resolve without manual fixes.
15. As a collector, I want Basic Energy lines to match by type when their code doesn't resolve (`SVALT 135`, `MEE 10`), so that every list's Energy comes through.
16. As a collector, I want a line whose code fails but whose name can mean only one card to resolve as **Matched by name**, so that game-only codes like `SWSHALT 127` don't block Save.
17. As a collector, I want a line whose name could mean several different cards to ask me to **Pick one**, showing each candidate, so that I choose the card the list meant.
18. As a collector, I want a line whose card isn't in the catalog to say **Not found**, with a link that reports it on Missing cards with the details filled in, so that the catalog can catch up.
19. As a collector, I want a line with no set code to be **Can't read** until I pick a card or drop it, so that nothing hand-typed is guessed for me.
20. As a collector, I want to search the catalog from any flagged line and pick the right card, so that I can fix any line myself.
21. As a collector, I want to **Drop line** on any flagged line, and restore it, so that I can leave out a card I'll add later.
22. As a collector, I want each line to keep showing the text I pasted, `PH` included, so that I can compare the match with the original.

### Owned cards

23. As a collector, I want the import to use copies I already own before choosing new ones, so that the Want List doesn't ask me to buy cards I have.
24. As a collector, I want **Exact printings** to use only owned copies of the named Printing, in any Edition, so that the Deck has exactly the Printings the list names.
25. As a collector, I want **Use cards I own** to also use owned copies of other Printings of the same card, so that I build from my binder whatever art I have.
26. As a collector, I want the import to start on **Use cards I own**, and each device to remember my choice, so that the default saves me money and my preference sticks.
27. As a collector, I want the setting in the review's side column, recounting every line as I switch, so that I can see what it changes before I save.
28. As a collector, I want each substitution spelled out ("Used 1 Iono PAL 254 · Holo you own · Binder"), so that I know exactly which copies the Deck will use.
29. As a collector, I want one pasted line to become several Deck List lines when it uses different owned Editions, so that the Deck List stays one Card Edition per line.
30. As a collector, I want copies another Deck needs for its own list to be left alone, with a note saying where they are, so that importing never quietly takes cards from another Deck.
31. As a collector with several Decks, I want the import to count owned copies the way the Want List does, so that the new Deck's needs match what the review showed.
32. As a collector counting **One Deck at a time**, I want the import to count copies sleeved in other Decks, labelled with that Deck, so that it agrees with how I count.
33. As a collector, I want owned Basic Energy of the right type to count for any Basic Energy line of that type under **Use cards I own**, so that my pile of Energy is used.
34. As a collector, I want copies I don't own to get the cheapest priced Edition of the named Printing, as adding by Printing already does, so that the shopping list is as cheap as it can be.
35. As a collector, I want **Edition** on any line to change the Edition its new copies get, including Reverse Holo for a `PH` line, so that I can choose a specific finish.
36. As a collector, I want Basic Energy that matched by type to show its default Edition, with **Change**, so that I can pick the Energy art I want.

### The review

37. As a collector, I want the review to open on **Needs you** whenever there are lines to resolve, so that I start with what only I can fix.
38. As a collector, I want **All**, **Changed** and **Dropped** filters, so that I can check substitutions and drops before I save.
39. As a collector, I want lines grouped into Pokémon, Trainer and Energy sections in paste order, with section totals worked out from the lines, so that the review reads like the list.
40. As a collector, I want the totals beside the list: cards (flagged when not 60), cards I own, and cards to get with their cost and how many are unpriced. That way, I know what the Deck will cost before I save.
41. As a collector, I want **Create Deck** or **Replace Deck List** disabled, saying how many lines are left, until every flagged line is resolved, so that I never save a half-matched list.
42. As a collector, I want the review not to repeat format warnings, so that the builder's format check stays the one place for legality.
43. As a collector on a phone, I want the side column above the list, a full-width resolver and a save bar above the tab bar, so that the review works with one thumb.

### Replace

44. As a collector, I want **Replace list…** in a Deck's builder, so that I can update a Deck to a new version of its list.
45. As a collector, I want the review to show **Will become Surplus**: the held cards the new list doesn't name. That way, I know what will be left over.
46. As a collector, I want copies the Deck already holds to be used first for the new list, so that cards stay where they are.
47. As a collector, I want copies the Deck holds of the named Printing to keep their own Edition even under **Exact printings**, so that my sleeved Reverse Holos don't become Surplus.
48. As a collector, I want nothing to move when I replace a list, with the leftovers in the builder's Surplus group and **Put away all**, so that I put cards away when I'm ready.
49. As a collector, I want **Undo** after a Replace to restore the old Deck List exactly, so that a mistaken paste costs nothing.
50. As a collector, I want a Replace to fail safely if the Deck List changed after I reviewed it, sending me back to the review, so that I never overwrite edits I didn't see.

### Copy to my Decks

51. As a collector viewing a Published Deck, I want **Copy to my Decks**, so that I can build a list I found on Discover.
52. As a collector, I want the copy to go through the same review and owned-cards setting, so that it uses my cards like any import.
53. As a collector, I want the new Deck named after the Published Deck and set to its Target Format, both editable, so that the copy starts out right.
54. As a collector, I want **Exact printings** to keep the Published Deck's Editions for cards I don't own, so that I can copy a list exactly as published.
55. As a collector, I want a card whose Edition has since been retired to fall back to its Printing, or be flagged if that's gone too, so that old Published Decks still copy.

### After saving

56. As a collector, I want every import to land in the Deck's builder with an Undo toast, so that Gather, Buy missing and Put away all are right there.
57. As a collector, I want **Undo** after creating a Deck to remove it, so that a mistaken import leaves nothing behind.
58. As a collector, I want a retried save never to create a second Deck, so that a flaky connection is harmless.

### The Want List

59. As a collector, I want a **My Decks / Want List** switch on Decks, so that I can see what all my Decks still need.
60. As a collector, I want one section per Deck, in creation order, so that I know which Deck each purchase is for.
61. As a collector, I want each line to show the exact Card Edition, "N of M" still needed, where my counted copies are, the line cost and the price each, so that I can shop line by line.
62. As a collector, I want a line I can't fill to say why ("Your 4 are counted for other Decks", or "None owned"), so that the count is explained.
63. As a collector, I want a Deck that needs nothing to collapse to "Nothing to get", so that the page shows only what matters.
64. As a collector, I want a summary at the top with the cards to get, their estimated cost and how many are priced, so that I know the total before shopping.
65. As a collector, I want unpriced cards reported separately and never counted as $0, so that the total isn't misleadingly low.
66. As a collector on desktop, I want a sticky combined total listing each card once with the Decks that need it, so that I can shop from one list.
67. As a collector on a phone, I want the combined total as a collapsed row under the summary that opens the same list, so that it doesn't push the sections away.
68. As a collector, I want each Deck card on My Decks to show "Want List: N cards · $X" and open the Want List scoped to that Deck, so that I can shop for one Deck.
69. As a collector, I want Deck chips to switch between All Decks and each Deck, so that I can change scope without leaving the page.
70. As a collector, I want **Open Deck** on each section, so that I can go to the builder.
71. As a collector, I want **Buy on TCGplayer** to export exactly what is showing (the combined total, or one Deck's needs) under my counting setting, with the existing coverage wording, so that the cart matches the page.

### Counting

72. As a collector, I want **Every Deck built at once** to be the default, so that two Decks never both count my one set of copies.
73. As a collector, I want spare copies to go to my oldest Deck first, so that the order is predictable and the sections add up to the total.
74. As a collector, I want copies another Deck holds for its own list never to count for a different Deck, so that sleeved cards stay with their Deck.
75. As a collector, I want **One Deck at a time** to count every copy for every Deck, with the total taking the largest need per card, so that I can see what one Deck needs on its own.
76. As a collector, I want the counting setting on a new **Settings** page, stored on my account, so that phone and desktop agree.
77. As a collector, I want the Want List to name the counting it uses, with a link to Settings, so that I know how the numbers were reached.
78. As a collector, I want a Deck's card, its builder's "to complete", **Buy missing** and its Want List section always to show the same number, so that I never wonder which is right.
79. As a collector, I want the desktop avatar menu and the phone More sheet to say **Settings** instead of **Sign-ins**, with my sign-ins still on that page, so that I find both in one place.

### Swap

80. As a collector, I want a line to say "↻ You own a playable version (PAL 254) × 1" when I have spare copies of another Printing in the same Reprint Group, so that I use what I own.
81. As a collector, I want **Swap** to move only as many copies as I own spare onto a line for that Edition, leaving the rest of the line, so that the Deck List stays exact.
82. As a collector, I want **Undo** after a Swap, so that I can take it back.
83. As a collector, I want the Swap hint to follow my counting setting, so that it only offers copies that are really available.

### The owner and the catalog

84. As the owner, I want reported missing cards from imports to arrive in the existing Missing cards queue with the pasted name, set and number, so that I can add them.
85. As the owner, I want a pasted set code PrizeCheck can't map to land in the set name and note, never as a set ID, so that manual Printings stay reachable by code tables.
86. As the owner, I want the import's alias table checked in with its evidence, separate from the display code table, so that its rules stay reviewable.

## Implementation Decisions

### Decklist text parsing

From [the text formats research](wayfinder/research/decklist-text-formats.md) and [the import contract](wayfinder/resolutions/decide-import-contract.md).

- **One pure parsing module on the server.** The browser sends text and draws the server's reading, so the grammar, the alias table and the name rules live in one place.
- **Normalising first:**
  - LF, CRLF and CR line endings;
  - a leading BOM;
  - NBSP and zero-width spaces;
  - trailing spaces;
  - NFC normalisation;
  - `’` read as `'`;
  - `Pokemon:` read as `Pokémon:`;
  - an optional `* ` bullet.

  TCG Online's empty-set Energy line (two spaces before the number) is recognised before repeated spaces collapse.
- **Line kinds:**
  - **header:** `Pokémon`, `Trainer`, `Trainer Cards`, `Energy` or `Energie`, with `:` or `-` and a number. It starts a section; its number is never used.
  - **ignored:** `Total Cards`, `Karten insgesamt` and `******` lines, and any line that doesn't start with a quantity.
  - **card:** quantity, name, set token, number and an optional `PH`, parsed from the right. The set token may be two to eight capitals or digits, optionally with a hyphenated subset of two to four (`PR-SV`, `CRZ-GG`), or `Energy` after a name ending in Energy. The number may carry a letter prefix or suffix.
  - **Can't read:** a line that starts with a quantity but has no set token and number.
- **Totals** are worked out from the lines, never from headers.
- **Limits:**
  - **Text:** at most 20,000 characters (422 `IMPORT_TOO_LONG`).
  - **Card lines:** at most 200 (422 `IMPORT_TOO_MANY_LINES`), matching the Deck List batch limit.

### Matching

Each card line is matched in this order. The first step that answers wins.

1. **Code and number.**
   - **The code** is looked up in the printed set code table, then in a new import alias table.
   - **The number** is compared the way catalog search compares numbers (zeros after a prefix don't count), after the alias table's number rules.
   - **Result:** one active Printing.
   - **No name cross-check.** The research found every name mismatch after a code match was a naming convention.
2. **Basic Energy by type.** This applies when the name is a Basic Energy in any spelling (`Basic {P} Energy`, `Psychic Energy`, `Basic Psychic Energy`) and step 1 found nothing.
   - **The default Printing** is that type's Basic Energy Printing in the newest Basic Energy set the catalog holds.
   - **Its Edition** comes from the allocation below.
3. **The name, when step 1 failed.** Names are compared letters and digits only, with no accents or punctuation, the normalisation catalog search already uses. A Printing's parenthetical subtitle is optional. Counting the distinct effective Reprint Groups among active matching Printings:
   - **one:** **Matched by name**, on the group's newest Printing by set release date;
   - **several:** **Pick one**, with one candidate per group (its newest Printing);
   - **none:** **Not found**.
4. **No code:** **Can't read**. Name matching never runs for these lines. A capitalised name suffix (EX, GX, V, VMAX, VSTAR and the like) read as the set token also counts as no code, so the line is Can't read rather than matched by a shortened name.

**The import alias table** is a new checked-in table, separate from the printed set code table. That display table keeps its two-source evidence rule; each alias row cites its own evidence.

- **Rows:**
  - `PR-SV` and `SVP` → SV promos;
  - `PR-SW` and `SP` → SWSH promos, with the number prefix `SWSH`;
  - `SMP` and `PR-SM` → SM promos (`SM`);
  - `XYP` → XY promos (`XY`);
  - `BWP` and `PR-BLW` → BW promos (`BW`);
  - `HSP` → HGSS promos (`HGSS`);
  - `DPP` → DP promos (`DP`);
  - `SVE` and `MEE` → the two Basic Energy sets;
  - `CEL` with a `CC` number → Celebrations Classic Collection.
- **Rules in code:**
  - `<code>-TG|GG|RC <n>` splits back to a prefixed number;
  - `SHF` and `HIF` flat numbers above 73 and 69 map back to Shining Vault numbers.
- **Never exported.** Nothing reads the table for exports, Format Standing or public records, and it doesn't feed the Live export's code table.
- **No rows for ALT codes.** Game-only codes (`SVALT`, `SWSHALT`) get no rows; their lines fall through to Basic Energy or the name.

### Allocation and Edition choice

From [the import contract](wayfinder/resolutions/decide-import-contract.md) and [the Want List contract](wayfinder/resolutions/decide-want-list-contract.md).

- **One shared allocation function.** It serves the import, the Want List, the builder's "to complete", the Mass Entry `not_owned` scope and the Decks index. The import asks it which copies are available to the Deck being built:
  - **Every Deck built at once:** this Deck's own copies, then Spare Copies left after older Decks have counted theirs. A new Deck counts as the newest.
  - **One Deck at a time:** any copy outside this Deck, including copies sleeved in other Decks.
- **Pasted lines are allocated in order** from one shared pool, so no copy counts twice.
- **Owned copies, in order:**
  - **Exact printings:**
    1. this Deck's copies of the named Printing (Replace only);
    2. available copies of the named Printing elsewhere.
  - **Use cards I own:** those two steps, then:
    3. this Deck's copies of other Printings in the Reprint Group;
    4. available copies of those Printings elsewhere.
- **Basic Energy stands in for a Reprint Group.** Basic Energy is in no Reprint Group. For the import's allocation only, every Basic Energy Printing of one Energy type counts as one group (effective Basic Energy attribute true and matching types). Reprint Groups and the Want List's Swap hint don't change.
- **Several owned Editions at one step.** The Edition with the most available copies goes first, then catalog order, which keeps the Deck List to as few lines as it can.
- **The rest of each line** gets add-by-Printing's rule: the cheapest stored quote among the named Printing's active Editions, otherwise the first Edition in catalog order. A Printing with only the Unspecified Variant gets that Edition. `PH` changes nothing.
- **Lines merge.** Parts naming the same Edition merge into one Deck List line (ADR 0009: one Card Edition per line).
- **Stored quotes only.** Like add-by-Printing, the review reads stored quotes and is not a price access (ADR 0006): it admits no refresh and waits for no runner.

### Copy to my Decks

- **The input** is the publication token. A revoked or missing publication answers 404, as the public read does.
- **Each snapshot row** is one review line, with its quantity:
  - its public Edition reference resolves to an active Edition;
  - otherwise, its public Printing reference resolves to an active Printing, whose Edition the allocation chooses;
  - otherwise, the line is **Not found**, with the row's name, set and number.
- **Under Exact printings,** the copies the collector doesn't own keep the snapshot's Edition. Owned copies of the named Printing still come first.
- **Defaults:** the name is the Published Deck's title and the Target Format is the snapshot's.
- **New Deck only.** Copy only creates a new Deck. To replace a Deck's list with a Published Deck, a collector pastes its Live export into Replace list….

### Import interfaces

- **`POST /api/decks/import/review`** is read-only and needs no idempotency key. It is a POST only because the text is long.
  - **Body:**
    - the source: pasted text, or a publication token;
    - the owned-cards setting (`exact` or `owned`);
    - the Deck being replaced, if any;
    - the collector's fixes so far: per line number, drop, a Printing or an Edition.
  - **Stateless.** The screen posts again on every setting change or fix.
  - **Capture.** It reads one consistent capture under the owner row lock, as the Want List read does. Its work grows with the pasted lines and the Holdings of the Reprint Groups they name.
  - **Returns:**
    - **lines,** each with: line number, raw text, section and quantity; status (`matched`, `by_name`, `energy`, `picked`, `ambiguous`, `not_found`, `unreadable` or `dropped`); the Printing; candidates; parts (Edition, quantity, source `in_deck` / `elsewhere` / `new` with Location or Deck names, and `chosen_by` for new copies); notes on copies kept for other Decks;
    - **ignored lines;**
    - **the merged Deck List** that saving would write;
    - **the Surplus preview,** for Replace;
    - **totals:** cards, owned and to get, with stored cost and Pricing Coverage;
    - **the counting setting used;**
    - **the owner and catalog revisions,** and the Deck List revision for Replace.
  - **Quantities** are base-10 strings.
- **`POST /api/decks/import`** creates a new Deck: name, Target Format, lines (Edition and quantity, at most 200) and an idempotency key.
  - **One transaction:** it creates the Deck and its Deck List, sets the Target Format and writes the lines.
  - **Checks:**
    - the name, as Create Deck checks it;
    - every Edition is active, of a Printing that isn't withdrawn (422 `EDITION_UNAVAILABLE`);
    - no Edition appears twice (422 `DUPLICATE_EDITION`).
  - **Returns** the Location node and the Deck List command result: the Deck List, the Target Format and its format result.
  - **Idempotency.** It replays like every Location command.
  - **Undo** is the existing Deck deletion.
- **Replace uses the existing Deck List changes batch** at the reviewed revision. The batch carries every new Edition at its total and `0` for every current line not on the new list.
  - **A stale review:** `STALE_DECK_LIST` sends the screen back to the review.
  - **Undo** is the inverse batch.
  - **Nothing moves.** No Holding moves, because Surplus is derived from Holdings beyond the Deck List.
  - **The 200-change cap** covers new plus removed lines.
- **What saving trusts.** Saving sends the resolved Editions, never the text, and the server doesn't resolve again. A "you own" note can go stale between review and save; the Deck List is still valid, because a Deck List never counts toward the Collection.
- **The Missing cards link** opens the existing report form:
  - kind Printing, with the English name and number filled in;
  - the pasted code goes into the set ID only when a code table maps it, and otherwise into the set name and note.

### Import screens

From [the import review step](wayfinder/resolutions/prototype-import-review.md). The [prototype](wayfinder/prototypes/import-review/README.md) shows variant A.

- **Entry points:**
  - Decks: **Import a list** beside Create Deck;
  - the deck builder header: **Replace list…** beside Export, Publish and Delete;
  - a Published Deck: **Copy to my Decks**.
- **The paste screen** holds the text box and the destination only:
  - **a new Deck:** its name (required) and Target Format;
  - **from the builder:** Replace this Deck's list.

  It shows a live count of card lines and cards, plus how many lines will be ignored. Copy shows the snapshot instead of a text box.
- **The review** is one list by section, in paste order.
  - **Filters:** **All / Needs you / Changed / Dropped** chips. It opens on Needs you when anything needs resolving.
  - **Problems expand inline:** a catalog search with candidates, **Drop line**, and the Missing cards link.
  - **Resolved lines** offer **Edition**, or **Change** for Basic Energy. Dropped lines offer **Restore**.
- **The side column** is sticky on desktop and stacks above the list on phones. It holds:
  - the totals;
  - the **Exact printings / Use cards I own** setting with its explainer;
  - the destination;
  - **Will become Surplus**, for Replace.
- **The owned-cards setting** starts on Use cards I own and is remembered per device, like other display preferences.
- **Save** is disabled with "N lines to resolve" until every flagged line is resolved. Every flow lands in the Deck's builder with an Undo toast.
- **Kit and layout.** The screens use the kit: dark theme, Prize gold tokens, 30 px controls and 44 px on phones, 24 px chips. Phone layout follows the shell's breakpoints. The review keeps a save bar above the tab bar on phones.

### The Want List

From [the Want List page](wayfinder/resolutions/prototype-want-list.md) and [the Want List contract](wayfinder/resolutions/decide-want-list-contract.md).

- **Spare Copy.** A copy that isn't covering any Deck's own Deck List line: loose copies outside every Deck, plus every Deck's Surplus.
- **Every Deck built at once:**
  - each Deck counts the copies it holds, up to its line's quantity;
  - Spare Copies go to Decks oldest first, by creation time with the Deck id breaking ties;
  - copies another Deck holds for its own line never count for a different Deck;
  - the total is the sum of the sections.
- **One Deck at a time:** each Deck counts every copy outside it as available, and the total takes the largest need per card.
- **Swap hint.** It appears on a line that still needs copies when another Edition in the same Reprint Group has copies the counting rule makes available:
  - **Every Deck built at once:** spare copies left after older Decks' own lines;
  - **One Deck at a time:** any copy outside this Deck.

  Swap is one Deck List changes batch that lowers the line and raises or adds the other, and its Undo is the inverse batch.
- **Swap hint and trading.** The [trading spec](../trading/spec.md) widens the Swap hint to also offer Editions a line's Will accept rule accepts. With Will accept left at this exact card, the hint is unchanged.
- **`GET /api/want-list`, optionally scoped to one Deck:**
  - one capture under the owner row lock, bounded by Deck List lines;
  - returns the counting setting, each Deck's section in creation order (per line: Edition, quantity, held, spare counted, counted from other Decks, need, Swap hint) and the combined rows.
- **`GET /api/want-list/cost`, same scope.** It is a price access under the access-triggered refresh rule (ADR 0006), with one evaluation, one admission and at most one wait inside one gateway budget. It returns the cost of the total and of each section, with Pricing Coverage. Rows that couldn't be read in time make the affected figures incomplete.
- **`GET /api/want-list/exports/tcgplayer`, same scope.** It reuses the Mass Entry formatter and its coverage and less-specific wording: the combined total, or one Deck's needs.
- **The Deck routes follow the setting.** The deck builder's cost-to-complete, the Mass Entry `not_owned` scope and the Decks index use the shared allocation, so today's figures become the One Deck at a time reading.
- **Gather is unchanged.**

### The Want List page

- **Where it lives:** a **My Decks / Want List** switch on Decks; the tab bar doesn't change.
- **Scoping:** a Deck card's "Want List: N cards · $X" button opens the view scoped to that Deck, and Deck chips switch the scope. The switch always opens All Decks.
- **The summary:** cards to get, estimated cost, cards priced, **Buy on TCGplayer**, and the counting setting as text with a link to Settings.
- **Sections:**
  - **Each line:** the Edition, "N of M", where the counted copies are, the line cost and the price each.
  - **Lines with nothing counted:** "Your N are counted for other Decks", or "None owned".
  - **A complete Deck** collapses to "Nothing to get".
  - **Open Deck** goes to the builder.
- **The combined total:** a sticky right column on desktop, and a collapsed row on phones. It is hidden when the view is scoped to one Deck.

### Settings

- **A new Settings page replaces Sign-ins.** It has a **Decks** section with the counting setting and a **Sign-ins** section with today's content.
- **Menus.** The avatar menu and the phone More sheet say **Settings**, and the old Sign-ins route redirects to it.
- **Stored on the account.** The counting setting is stored on the account, defaulting to Every Deck built at once. It is read and written through a small authenticated settings route, idempotent and revision-checked like other owner commands.

### Domain vocabulary

`CONTEXT.md` now defines **Want List**, **Spare Copy** and **Decklist Import**. Deck List lines stay one Card Edition each (ADR 0009); no "any printing" line exists.

## Testing Decisions

### What makes a good test

A good test checks what a collector or a caller can observe:

- a route's status and body;
- a Deck List's lines after a command;
- a page's visible text, roles and focus;
- an Undo that restores exactly what was changed.

It doesn't assert module names, SQL, CSS classes or component structure. Tests go through the highest seam that shows the behaviour. The owner confirmed two seams, both already in the repository.

### 1. The HTTP API (pytest, signed HTTP against PostgreSQL)

Prior art: `test_deck_list_printing.py` (stored quotes and catalog order), `test_deck_list_changes.py` (batch, revision and inverse batch), `test_deck_surplus.py`, `test_deck_mass_entry.py`, `test_deck_cost.py`, `test_publications.py` and `test_missing_cards.py`.

- **The parser, through the review route.** There are no parser unit tests. Each of the nine research fixtures is posted to the review against a seeded test catalog, and its lines' sections, quantities, statuses and ignored lines are asserted. Cases:
  - line-count versus card-count headers;
  - German headers;
  - prose around a list;
  - CRLF and CR;
  - a BOM;
  - NBSP and zero-width spaces;
  - TCG Online bullets and the empty-set Energy line;
  - `PH`;
  - a colon in a name;
  - a line with no code;
  - the 20,000-character and 200-line limits.
- **Matching:**
  - a code and number found directly;
  - each alias row and rule;
  - Basic Energy by type for `SVALT`, `Energy N` and an Energy code missing from the catalog;
  - a failed code whose name names one Reprint Group, several, or none;
  - no name cross-check after a code match.
- **Allocation:**
  - Exact printings versus Use cards I own on the same paste;
  - the step order;
  - most-copies-first among Editions;
  - a split line;
  - shared-pool order across two lines naming one card;
  - copies held for another Deck's line left alone under Every Deck built at once and counted under One Deck at a time;
  - spares already counted by an older Deck not used;
  - Basic Energy of one type standing in for a group;
  - Replace using the Deck's own copies first, and keeping held Editions of the named Printing under Exact printings;
  - the cheapest stored quote, catalog order without quotes, and the Unspecified Variant;
  - no runner launch and no record-store write.
- **Copy to my Decks:**
  - an Edition reference, a retired Edition falling back to its Printing, and a withdrawn Printing as Not found;
  - Exact printings keeping snapshot Editions;
  - a revoked token answering 404.
- **Create-with-list:**
  - atomic with the Target Format;
  - idempotent replay;
  - the name checks;
  - `EDITION_UNAVAILABLE` and `DUPLICATE_EDITION`;
  - Undo by Deck deletion.
- **Replace:**
  - the batch that the review's merged Deck List produces;
  - `STALE_DECK_LIST` after an edit;
  - the inverse batch restoring the list;
  - Surplus in the Deck detail equal to the review's preview;
  - no Holding change.
- **The Want List:**
  - oldest-first allocation with the creation-time tie-break;
  - the worked Iono example (Charizard ex needs 2, Gardevoir ex needs 2, total 4);
  - One Deck at a time taking the largest need;
  - sections adding up to the total;
  - the Swap hint under each setting;
  - Swap and its Undo;
  - the scoped read;
  - the cost route's Pricing Coverage, unpriced copies and incomplete figures, with one admission;
  - the export's scope and wording.
- **One number everywhere:** for one Collection, the Want List section, the Decks index, cost-to-complete and the Mass Entry `not_owned` scope agree under both settings.
- **Settings:** the default, a revision-checked change, idempotent replay, and every figure above following the change.
- **Missing cards prefill:** a mapped code reaches the set ID; an unmapped one reaches only the set name and note.

### 2. The browser (Playwright specs on per-worker stacks)

Prior art: `deck-builder.spec.ts`, `deck-editing.spec.ts`, `deck-surplus.spec.ts`, `deck-gather.spec.ts`, `published-deck.spec.ts`, `mass-entry.spec.ts`, `sign-ins.spec.ts` and `mobile-journey.spec.ts`. Workspace specs start each test as a new owner.

- **Import, new Deck:** paste the Limitless fixture, name the Deck, review opens on Needs you, pick and drop the flagged lines, Save enables, and the result lands in the builder with Undo, which removes the Deck.
- **The setting:** switching it in the side column recounts the lines and the totals, and a reload on the same device keeps the choice.
- **Replace:** paste over a Deck holding cards; **Will become Surplus** matches the builder's Surplus group after saving; Undo restores the list; an edit in another tab sends the save back to the review.
- **Copy to my Decks:** from a Published Deck, through the review, to a new Deck named after it with its Target Format.
- **The Want List:**
  - My Decks / Want List switch, sections, summary and combined total;
  - a Deck card opens the scoped view and chips change scope;
  - Swap and Undo;
  - Buy on TCGplayer's dialog wording;
  - the counting text and its link.
- **Settings:** the menus say Settings; the old Sign-ins address redirects; changing the counting setting changes the Want List, a Deck card and the builder's "to complete".
- **Phone width:** the review, the Want List and Settings have no horizontal scroll; the save bar sits above the tab bar; controls are 44 px.
- **Accessibility:** flagged lines, filter chips and the disabled Save have names and states a screen reader announces, and focus moves to the resolver when Fix opens it.

## Out of Scope

- Binder, set-completion or other wants that aren't for a Deck. The Want List is derived only and can't be edited directly.
- Sharing the Want List, or requesting cards from other collectors.
- Importing a whole collection, and export formats beyond the existing ones.
- Identity-level ("any printing") Deck List lines.
- Merging a paste into an existing Deck List. Batch add covers adding a few cards.
- Inferring a Target Format from a paste or from card legality.
- Mapping TCG Live's game-only ALT codes to printed cards.
- Letter-suffix Printings that TCGdex doesn't have (`TEU 152a`).
- Copying a Published Deck over an existing Deck's list.

## Further Notes

- **Unconfirmed formats.** Some TCG Live details are unconfirmed:
  - Windows line endings and a trailing newline;
  - other client languages;
  - what `PH` and `SVALT` numbers mean;
  - whether Live itself uses the `-TG`, `Energy N` and flat-number forms.

  The parser accepts every variant the research saw. A pasted Live export would settle the rest, and the alias table can grow from it.
- **Coverage.** With the alias table, the set-code research measured 3,031 of 3,037 non-Energy Standard Printings reachable from pasted forms. The remaining failures go through the review's search, Drop line or the Missing cards report.
- **Changed figures.** The Want List's oldest-first counting changes today's "to complete" and Buy missing under the default setting: a newer Deck can show a larger figure than it does now. This is intended. Today's figure is the One Deck at a time reading.
- **The prototypes are design evidence only:** [import review](wayfinder/prototypes/import-review/README.md) and [Want List](wayfinder/prototypes/want-list/README.md).
