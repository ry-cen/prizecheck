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

## Manual checks that automation does not cover

- [ ] Real touch on iOS Safari and Android Chrome for the tab bar, the More sheet and the ☰ drawer (the browser tests only emulate touch), including the home indicator area under the tab bar.
- [ ] Screen reader walkthrough (VoiceOver on macOS and iOS, NVDA on Windows): the tabs announce the current page, the avatar menu announces as a menu, and the drawer and sheet announce their titles and return focus when they close.
- [ ] Safari and Firefox on desktop: the avatar menu, the sticky header and the dialogs (the browser tests run in Chromium only).
- [ ] Screen reader on the sign-in card: the heading and subtitle are read first, the Email and Six-digit code fields are named, and "a code has been sent" is announced. On a slow load, "Loading…" is announced once (#163).
- [ ] Until the dark first paint (rollout stage 7), a slow first load still shows a brief light page before the dark loading screen. That is expected for now (#163).
- [ ] Screen reader on Collection: with Names off, a tile is read with its Variant (or "Unspecified Variant"), and the inspector's Leaf list is read as a list (#164).

## Sources

The [app redesign spec](spec.md), the [app shell resolution](wayfinder/resolutions/decide-app-shell.md), the [component kit resolution](wayfinder/resolutions/decide-component-kit.md) and the [rollout resolution](wayfinder/resolutions/decide-rollout-and-verification.md).
