# App redesign launch checklist

**Status:** pending. Automated evidence comes from `npm run verify`; nothing here is recorded as done.

The redesign is a launch gate ([spec](spec.md), "Rollout"): PrizeCheck opens to anyone besides the owner only once every page is in the new shell and every walkthrough below is ticked. Each page ticket adds its own walkthrough of 5–10 steps, run on a phone and on a desktop. Code merges to `dev` on the automated checks; these walkthroughs are the owner's own check before launch.

## Implementation evidence

- [ ] Each redesign ticket's acceptance ran the full gate (`npm run verify`) once and quoted the pytest, vitest and Playwright counts from its `verification.log`.
- [ ] Every page passes the shared page check (`web/tests/support/page-check.ts`) at 1280×800 and 375×812, with its dialogs and sheets open as well as closed.

## Release notes

- [ ] `/collection` is the default page, the sign-in landing and the sign-out redirect. `/`, `/workspace` and `/locations` redirect to it, keeping any `?location=` link (#162).
- [ ] The old Collection page moved to `/old-collection`, with no link, until #164 retires it (#162).
- [ ] `GET /auth/session` also returns the signed-in `email`, for the avatar menu (#162).

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

## Manual checks that automation does not cover

- [ ] Real touch on iOS Safari and Android Chrome for the tab bar, the More sheet and the ☰ drawer (the browser tests only emulate touch), including the home indicator area under the tab bar.
- [ ] Screen reader walkthrough (VoiceOver on macOS and iOS, NVDA on Windows): the tabs announce the current page, the avatar menu announces as a menu, and the drawer and sheet announce their titles and return focus when they close.
- [ ] Safari and Firefox on desktop: the avatar menu, the sticky header and the dialogs (the browser tests run in Chromium only).

## Sources

The [app redesign spec](spec.md), the [app shell resolution](wayfinder/resolutions/decide-app-shell.md), the [component kit resolution](wayfinder/resolutions/decide-component-kit.md) and the [rollout resolution](wayfinder/resolutions/decide-rollout-and-verification.md).
