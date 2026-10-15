# Resolution — Want List contract

**Owner confirmed:** 2026-10-14

**Ticket:** [Decide the Want List contract](https://github.com/ry-cen/prizecheck/issues/204)

**Builds on:** [the import and Want List behaviour](decide-import-and-want-list-behaviour.md) and [the Want List page](prototype-want-list.md).

## Decision

### Spare copies

A **spare copy** is a copy that isn't covering any Deck's own Deck List line. That means loose copies in non-Deck Storage Leaves, plus every Deck's Surplus (copies a Deck holds beyond its own line). This is the rule the deck builder's competition warning and Gather's source order already use.

### Every Deck built at once (the default)

- **A Deck's own copies come first.** Each Deck counts the copies it holds, up to its line's quantity.
- **Spare copies go to Decks oldest first.**
  - **Order:** the Deck created earliest takes spare copies first, with the Deck id breaking ties.
  - **Why not the id alone:** Deck ids are random, so they don't sort by age.
  - **Imports:** a Deck created by import or Copy to my Decks counts from the moment it was created.
  - **Counted once:** each spare copy counts toward one Deck only.
- **Copies another Deck holds for its own line never count** for a different Deck.
- **The total adds up.** It is the sum of the Decks' sections, so each section is exactly what that Deck adds to the shopping list.

For example, take Iono PAL 185 with Charizard ex (older) listing 4 and holding 1, Gardevoir ex (newer) listing 2 and holding 0, and one loose spare copy. Charizard ex takes the spare and needs 2, Gardevoir ex needs 2, and the total is 4.

### One Deck at a time

- Each Deck counts every copy outside it as available, including copies sleeved in other Decks.
- The total takes the largest need per card.

### Every place shows the same number

A Deck's need follows the collector's counting setting everywhere it appears:

- its Want List section;
- its card on My Decks;
- the deck builder's "to complete" and **Buy missing**;
- the Want List's Mass Entry export.

Today's "to complete" and Buy missing (the `not_owned` scope) are exactly the **One Deck at a time** reading. Only the default setting changes them: under it, a newer Deck can show a larger "to complete" than it does today.

### Swap hint

- **When it appears.** A line that still needs copies shows the hint when the collector has copies of another Edition in the same Reprint Group that the counting rule would make available:
  - **Every Deck built at once:** spare copies of that Edition left after older Decks' own lines have counted them;
  - **One Deck at a time:** any copy of that Edition outside this Deck.
- **What it does.** Swap moves only that many copies onto a line for the other Edition and leaves the rest of the line as it is (settled by [the Want List page](prototype-want-list.md)).

### The setting lives in Settings, on the account

- **A Settings page.** The counting setting moves off the Want List into a new **Settings** page. That page replaces today's **Sign-ins** page and has two sections:
  - **Decks:** the Want List counting setting;
  - **Sign-ins:** today's page content.
- **Menus.** The desktop avatar menu and the phone More sheet say **Settings** instead of **Sign-ins**.
- **On the Want List.** It shows the counting it uses as text ("Counting: Every Deck built at once"), with a link to Settings. It has no toggle of its own.
- **Stored on the account,** so phone and desktop agree. This replaces the per-device storage the behaviour resolution assumed for this setting. The import's **Exact printings** / **Use cards I own** choice stays where it is.

### Prices

- **Access.** Opening the Want List's cost counts as access to every Edition it prices, under the access-triggered refresh rule (ADR 0006).
- **One budget.** Like Deck cost, one request covers every needed Edition. It evaluates and admits refresh once and waits at most once, within one gateway budget.
- **What it reports.** The cost of the total and of each section, each with Pricing Coverage: priced copies out of needed copies. Unpriced copies are reported separately and never counted as $0. Rows that couldn't be read in time make the affected figures incomplete, as Deck cost does.

### Interfaces

- **`GET /api/want-list` (optional `deck=<id>`).**
  - **One capture:** a single consistent capture of the owner's Deck Lists and the Holdings of the Editions they name, under the owner row lock that every Deck List and Holding writer takes.
  - **Bounded:** its work grows with the collector's Deck List lines, not with the whole Collection. Deck List lines and Holdings are read as range reads and paired in memory, as the ownership read does.
  - **Returns:**
    - the counting setting it used;
    - each Deck's section, in creation order: each line's Edition, quantity, copies held, spare copies counted, copies counted from other Decks (One Deck at a time only), the need, and any Swap hint;
    - the combined rows.
  - **Quantities** are base-10 strings, as elsewhere.
- **`GET /api/want-list/cost` (optional `deck=<id>`).** The prices for the same scope, as a separate request so the page draws before prices arrive.
- **`GET /api/want-list/exports/tcgplayer` (optional `deck=<id>`).** It reuses the Mass Entry formatter and the existing coverage and less-specific wording.
  - **With no `deck`:** the combined total.
  - **With a `deck`:** that Deck's needs.
- **Deck routes follow the setting.** The deck builder's cost-to-complete and its Mass Entry `not_owned` scope use the same allocation, through one shared function.
- **Swap** is one existing Deck List changes batch (`POST /api/decks/{id}/deck-list/changes`). It lowers one line and raises or adds the other in one revision, and Undo is the inverse batch, as the builder's swap already works.
- **Gather is unchanged.** It still suggests spare copies first, whichever Deck they are counted for. Once copies move into a Deck they are that Deck's own, and the counts follow.

## Changes to earlier decisions

- **Settings page.** [The Want List page](prototype-want-list.md): the counting control moves from the Want List summary to the Settings page.
- **Account storage.** [The import and Want List behaviour](decide-import-and-want-list-behaviour.md): the Want List counting setting is stored on the account, not per device.
- **The builder's figures.** [Decide the Deck experience](../../../app-redesign/wayfinder/resolutions/decide-deck-experience.md): the builder's "to complete" and Buy missing follow the counting setting, as the Want List page resolution already recorded. Under the default they now use oldest-first allocation.
