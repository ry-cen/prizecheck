# Missing cards and Owner controls prototype

This prototype supports [Prototype Missing cards and Owner controls](https://github.com/ry-cen/prizecheck/issues/139). It is design evidence for development only, not production code.

## Where the code is

The code lives in `web/src/prototypes/owner-reports/`, inside the shell prototype. It is on the throwaway branch `prototype/owner-missing`, cut on top of `prototype/catalog-search`.

- **Run it.** Run `npm run dev:web -- --port 5186 --strictPort` and open `/collection?prototype=shell&ops=A` (or `B` or `C`).
  - **Desktop:** Missing cards is a tab, and Owner controls is in the avatar menu.
  - **Phone:** both are in the More sheet.
- **Switch variants.** On either page, the switcher's arrows cycle the variants. Its menu has an `ops` picker, and a `pull` picker that sets the catalog pull to running, stale or done.
- **Data.** In-memory sample data only. Every decision is a stub that shows a toast.

## The question

How do Missing cards and Owner controls look and behave on the shared components, on desktop and phones? In particular:

- how the dense review queues and review cards read;
- how a collector files and follows a missing-card report;
- how the owner's catalog pull, operations health and reviews are laid out.

## What every variant keeps (today's features)

- **Catalog pull:** last success, the run's phase and counts, start and refresh, and the stale-progress warning.
- **Operational health:** backups, restores, the watchdog, sign-in, the private API, catalog and public delivery, and provider allowances with the 70% warning.
- **Catalog reconciliation:**
  - every decision, including "Deprecate Printing and map every Edition" with one replacement per Edition;
  - reason, evidence and a fresh code.
- **Metadata review:**
  - source and reviewed values;
  - linked reports, with Ask for information and Reject report;
  - the decision with product and variant;
  - decision history;
  - Load more;
  - rule activation with a code.
- **Missing-card review:**
  - verified fields;
  - Request information, Reject, and Approve with a fresh code;
  - Begin a record directly.
- **Collector reports:**
  - Missing Printing or Missing Edition, with evidence and a note;
  - your reports with their status and the owner's response;
  - a reply box when the owner asks for information.

**Drawn but with no UI on `dev` today:** the **card attributes** queue (with Trainer Type, from [Decide the deck builder, Catalog and public data contracts](https://github.com/ry-cen/prizecheck/issues/138)) and the **Reprint Groups** queue. Their review routes and generated clients exist on `dev`, but no page calls them. The Deck Lists spec put all web UI out of its scope. They are marked "No UI on dev today" in every variant.

## Variants

- **A — Sections + tables.**
  - **Owner controls:**
    - a line of health problems;
    - sub-tabs: Status · Catalog · Metadata · Attributes · Reprints · Missing cards · Rules, each with its count;
    - each queue is a ScrollTable. **Review** opens the review card inline under its row, pinned to the table's visible width while the table scrolls.
    - The six-digit code step is **on the card**: Send code, the code, then Confirm decision.
  - **Missing cards:** keeps today's split.
    - **My reports** is a table, with Reply opening inline on a "needs info" row.
    - **Report a card** is today's form.
    - Metadata reports stay in Catalog's card popup.
- **B — Inbox.**
  - **Owner controls:**
    - the queues sit in the shell's sidebar (☰ drawer on a phone): Status, then each queue with its count, then Rules;
    - each queue is a list with a detail pane, which on a phone or below 1100 px opens as its own screen with ‹ Back;
    - decision buttons ("Correct mapping…") open **one confirm dialog**, which sends the code as it opens and takes it (a bottom sheet on a phone).
  - **Missing cards:** becomes the one **My reports hub** for every kind of report: missing card, metadata and attribute.
    - Filter chips: All · Needs your reply · Open · Closed.
    - Each report is a conversation with the owner, with the reply box under it.
    - **Report a missing card** is in the page header and opens a dialog.
- **C — Dashboard + focused review.**
  - **Owner controls:**
    - opens on **Needs you** tiles (each queue's count and oldest age) and **Status** tiles (the pull with a progress bar, and one tile per health group showing its worst check, which expands);
    - a queue tile starts a **one-at-a-time review** ("Metadata · 1 of 7+", ‹, Skip ›);
    - a **sticky decision bar** holds the decision, the code and **Confirm & next**.
  - **Missing cards:**
    - a **guided three-step report**: what's missing (a whole card, or a version of one), identify it, evidence. Identifying a Missing Edition **searches for the Printing** instead of asking for a raw Printing ID.
    - Report cards follow, with a short timeline. Ones that need your reply come first.

## Owner verdict — 2026-10-12

1. **Variant A** for both pages: sub-tabs over ScrollTables, the review card inline under its row, and the code step on the card.
2. **The attribute and Reprint Group queues are in this redesign,** as two more Owner controls sub-tabs.
3. **B and C are not taken forward.**
4. The full decision is in [the Missing cards and Owner controls resolution](../../resolutions/decide-owner-and-missing-cards.md).

## Checks — 2026-10-12

- **Build.**
  - `npx tsc -p web/tsconfig.json --noEmit` passed.
  - `vite build --config web/vite.config.ts` passed, and its output contains none of the prototype's markers.
- **Every variant, both pages, at 1280×800 and 375×812.** No page-level horizontal scroll. Wide tables scroll inside their own container.
- **Tap targets.** At 375×812, every visible button, link, input, select and summary on both pages is at least 44 px tall, or has a 44 px tap area.
- **Desktop, 1280×800.**
  - **A:** the Catalog queue's review card opened inline with the four-Edition mapping table.
  - **B:**
    - the sidebar queues, the list and the detail pane sit side by side;
    - Missing cards shows the report list beside the thread;
    - **Report a missing card** opens its dialog.
  - **C:**
    - shows 6 queue tiles and 5 status tiles;
    - Metadata opened as "1 of 7+", with the decision bar stuck to the bottom;
    - the "needs info" report card comes first.
- **Phone, 375×812.**
  - **A:**
    - the inline review card is 345 px inside a 347 px table viewport;
    - My reports' Reply opens inline with a reply box;
    - a missing-card review offers Request information, Reject, and Approve with a code.
  - **B:**
    - picking a queue from the ☰ drawer closes the drawer;
    - a row opens the detail full width;
    - the confirm dialog is a bottom sheet.
  - **C:**
    - the guided report reached the Printing search with three matches;
    - the decision bar sits at the bottom of the screen above the tab bar.
- **Matches today's flows.**
  - A missing-card review's Request information and Reject need only a reason. Only Approve takes a fresh code.
  - Every other decision takes a reason, a review evidence URL and a fresh code.
- **Fixed during the checks.**
  - The kit button style was scoped to the deck builder and Catalog, so it was extended to these pages.
  - C's decision bar floated mid-screen. The shell's main area keeps 160 px (desktop) or 180 px (phone) of bottom padding for its dock, and the bar's sticky offset now accounts for it.
  - Fixes for problems a review found:
    - A had no Request information or Reject;
    - only missing-card reviews had an evidence field;
    - the code step gated actions that need only a reason today;
    - A's sub-tabs (38 px), inline links and C's health tiles were under 44 px on a phone.
- **Not verified.** Real touch gestures, focus return when a dialog closes, and screen-reader reading of the inline table card.
