# Resolution — App shell and navigation

**Owner confirmed:** 2026-10-12

**Ticket:** [Prototype the app shell and navigation](https://github.com/ry-cen/prizecheck/issues/122)

**Evidence:** [app shell prototype notes](../prototypes/app-shell/README.md). Variant A of three was chosen.

## Decision

Every signed-in page sits inside one persistent shell: **top tabs on desktop, a bottom tab bar on mobile**. Switching pages swaps only the page area; the header and navigation never reset.

### Desktop

- The header holds the PrizeCheck wordmark, then page tabs: **Collection, Decks, Catalog, Missing cards**. The current page's tab is marked.
- An **avatar menu** at the right of the header holds the signed-in email, **Owner controls** (owner only) and **Sign out**. Owner controls is not a tab.
- Below the header, a page that has its own side content shows it in a left sidebar. Collection shows the Location tree. Other pages' side content (for example, a Deck index or Catalog filters) is decided in their own tickets.
- Each page has its own page header: a title on the left and page actions on the right, such as Add cards or Publish.

### Mobile

- A slim top header holds:
  - on the left, a ☰ control that opens the page's side content in a left drawer (Collection: Locations), or the wordmark when the page has none;
  - the page title;
  - the page's own header controls (Collection: Search and Filters & display).
- A **bottom tab bar** holds Collection, Decks, Catalog and **More**. More opens a bottom sheet with Missing cards, Owner controls (owner only) and Sign out.
- Collection's Actions strip and Undo toast sit **above** the bottom tab bar.
- Every target is at least 44 px. No page scrolls horizontally; a wide table, such as Owner controls' review queues, scrolls inside its own container.

### Pages keep their state

Leaving a page and coming back restores it as it was. For example, Collection keeps:

- its Location;
- its selection;
- its scroll position;
- its search, filters and display choices.

Returning to a page must not flash placeholder tiles or change the layout's size. This also covers [Workspace flashes gray placeholder tiles and jumps in size on every Location switch](https://github.com/ry-cen/prizecheck/issues/121). The existing rule that a fresh visit resets search and selection still applies to a new visit, such as a reload. It does not apply to switching tabs within the app.

### Signed-out pages

Published Deck, Discover and sign-in share one slim public header: the wordmark, a Discover decks link and a Sign in button. It uses the same theme and components as the signed-in app.

### Unchanged

- Dark only, on the shared design variables from [Decide responsive visual system](https://github.com/ry-cen/prizecheck/issues/47).
- All routing happens in the client (no full page loads), which keeps a future Electron app possible.

## Not decided here

- What side content Decks and Catalog show, and where. Their own tickets decide this.
- Mobile Select mode placement on Collection. The prototype put Select in the page header; the existing workspace behaviour stands until the spec says otherwise.
