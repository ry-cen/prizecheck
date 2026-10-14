# Resolution — Missing cards and Owner controls

**Owner confirmed:** 2026-10-12

**Ticket:** [Prototype Missing cards and Owner controls](https://github.com/ry-cen/prizecheck/issues/139)

**Evidence:** [Missing cards and Owner controls prototype notes](../prototypes/owner-reports/README.md). Variant A was chosen out of three, for both pages.

## Decision

Both pages use variant A, **sections + tables**: sub-tabs over sideways-scrolling tables, with the review card opening inline under its row.

### Owner controls

- **Problems line.** A line of pills at the top lists every health check that isn't OK, worst first: a stale backup, a 70% allowance warning, an unverified measurement.
- **Sub-tabs**, each queue with its count: **Status · Catalog · Metadata · Attributes · Reprints · Missing cards · Rules**. On a phone the tab row scrolls sideways inside its own container.
- **Status:**
  - The catalog pull panel: last success, the run with its phase and a progress bar, the enumerated, fetched and validated counts, **Refresh** and **Start full pull**. When progress is stale, the button reads **Restart pull** and a warning explains why.
  - Operational health as a ScrollTable: area, check, value pill, detail.
- **Each queue is a ScrollTable** of card, set and number, kind, reports, opened and age, with a **Review** button per row. Metadata keeps **Load more**.
- **Review opens the review card inline,** in a row under the item. The card stays the width of the table's visible area and pinned to its left edge while the table scrolls sideways. One item is open at a time, and **Close** folds it away.
- **The review card holds what today's review holds:**
  - **Catalog:** the incoming source change, the replacement Printing and the per-Edition mapping table, with each Edition's Holdings count.
  - **Metadata:** source and reviewed values side by side, with differences highlighted. Linked reports each offer Ask for information and Reject report. Then product ID and quote variant, and the decision history folded away.
  - **Missing cards:** the report, its note and evidence, and the verified fields. **Begin a record directly** sits folded above the table.
  - **Rules:** a card per rule kind with its active and latest versions and code digest, and an Activate step when a newer version is ready.
- **Deciding happens on the card:**
  - The reason and a review evidence URL come first. Missing-card reviews skip the evidence field because their own fields include it.
  - **Request information** and **Reject** on a missing-card report need only the reason, as today.
  - Every other decision is a Decision picker, then the code step on the card: **Send code**, the six-digit code, then **Confirm decision** (or **Approve shared record**).
  - A confirmed decision removes the row and shows a toast.

### New queues: card attributes and Reprint Groups

The owner brought both into this redesign on 2026-10-12. Their review routes and generated clients exist on `dev`, but no page calls them. The Deck Lists spec left all web UI to this work.

- **Attributes:** the reviewed card attributes as a table: derived value, correction and effective value per attribute. The rows are card kind, **Trainer Type**, regulation mark, rule box, ACE SPEC, evolves-from and the rest. The decision is Correct or Remove correction, and linked collector reports close with it. This is how a wrong Trainer Type gets fixed in the app, which the type chips depend on ([Decide the deck builder, Catalog and public data contracts](https://github.com/ry-cen/prizecheck/issues/138)).
- **Reprints:** each Card Identity in review as a table of its Printings: regulation mark, current Reprint Group with its legality, and a **Move to** picker. The decisions are moving Printings between groups and merging one Card Identity into another.
- Both decide with a reason, evidence and a fresh code, like the other queues.

### Missing cards

- **Two sub-tabs: My reports and Report a card.**
- **My reports** is a ScrollTable of card, kind, status pill, sent date and the owner's latest response. A report that needs information has **Reply**, which opens an inline row with the conversation so far and a reply box.
- **Report a card** is today's form on the shared components: Missing Printing (set ID, set name, number, English name) or Missing Edition (Printing and the physical variant details), then an evidence link and a note.
- The page lists missing-card reports only. **Metadata reports stay in Catalog's card popup**, as [Prototype Catalog search in the shell](https://github.com/ry-cen/prizecheck/issues/126) decided.

### Sizes and phones

- Kit sizes from [Decide the shared component kit](https://github.com/ry-cen/prizecheck/issues/137): 30 px controls and 24 px pills on desktop, 44 px on phones.
- On a phone, the sub-tab segments and inline links get 44 px tap areas.
- No page scrolls sideways. Wide tables scroll inside their own ScrollTable.

## Not taken forward

- **B, Inbox:** the queues in the sidebar, each a list with a detail pane; one confirm dialog that sends and takes the code; Missing cards as a hub for every kind of report, shown as conversations.
- **C, Dashboard + focused review:** status and queue tiles, a one-at-a-time review with a sticky decision bar, and a guided three-step report with a Printing search.

## Not decided here

- Rollout order. [Decide rollout and verification](https://github.com/ry-cen/prizecheck/issues/141) decides it. One constraint from this decision: the Attributes queue's Trainer Type correction should ship no later than the type chips that depend on Trainer Type.
- Focus return when an inline review card closes, and how a screen reader reads a card inside a table row. The spec should cover both.
