# App redesign — decision map

**Label:** wayfinder:map

**Status:** charted 2026-10-12; frontier open; app shell decided 2026-10-12

## Destination

An agreed plan, ready for owner-invoked `/to-spec` and `/to-ticket`, that puts every page of PrizeCheck into one persistent, mobile-first app shell on the shared dark design system, so the app feels like one seamless web app. The pages are Collection (the renamed workspace), Decks with the full Deck List UI, Catalog, Missing cards, Owner controls, sign-in and loading, Published Deck and Discover. This effort resolves decisions only. The spec at `docs/planning/app-redesign/spec.md`, the implementation tickets and the application code come after this map.

## Notes

- Owner request on 2026-10-12: give the pages still on the old light UI the new design, cohesive across pages like a seamless web app.
- **One persistent shell.** Switching pages never resets the whole screen. Every signed-in page shares the header and Main views. Signed-out pages (Published Deck, Discover, sign-in) use the same theme with a slimmer public header.
- **Collection.** The collector workspace is renamed Collection, lives at `/collection` and is the default page after sign-in. `/workspace` and `/locations` redirect there. Only user-facing names change; code identifiers such as `web/src/workspace/` and `ws-` classes stay. The old Collection page is retired if Collection covers its features.
- **Features stay the same** on every page except Decks. Decks gains UI for everything in the [Deck Lists and format validation spec](../../deck-format-validation/spec.md), whose "Web UI changes" were deferred to this work: Deck List editing, ownership states, Pick List, advisory format results, cost to complete, the not-owned Mass Entry export and publishing a Deck List snapshot.
- **Visual system.** Follow [Decide responsive visual system](https://github.com/ry-cen/prizecheck/issues/47) ([resolution](../../tcg-collection-tracker/wayfinder/resolutions/28-decide-responsive-visual-system.md)): dark only, Prize gold default, shared design variables in `web/src/tokens.css`, WCAG 2.2 AA, visible focus, 150 ms or less motion and none under reduced motion.
- **Mobile everywhere.** Every page, Owner controls included, is mobile friendly: 44 px targets, no page-level horizontal scroll.
- **Future Electron app.** Not built here, but the shell must not rule it out: client-side routing only, no reliance on browser chrome, touch and pointer both first-class.
- The shell must not reintroduce [Workspace flashes gray placeholder tiles and jumps in size on every Location switch](https://github.com/ry-cen/prizecheck/issues/121), filed separately as a bug.
- Use grilling and domain-modeling for decision tickets and prototype for prototype tickets. Use `CONTEXT.md` vocabulary (Collection, Location, Storage Leaf, Deck, Deck List, Pick List, Published Deck) and record new terms there as they are resolved. Consult Laya before delegation. Commit and push only with owner approval; stage explicit paths.
- Tickets are GitHub Issues labelled `wayfinder` and `feature: app redesign`, blocked with GitHub's native dependencies and a "Blocked by" body line. Prototypes, research and resolutions live beside this map. Implementation goes on `feature/app-redesign`, cut from `dev`.

## Decisions so far

<!-- One line per closed ticket: link plus a one-line gist. -->

- [Prototype the app shell and navigation](https://github.com/ry-cen/prizecheck/issues/122): Variant A. Desktop has top tabs (Collection, Decks, Catalog, Missing cards) and an avatar menu with Owner controls and Sign out. Mobile has a bottom tab bar (Collection, Decks, Catalog, More), and ☰ opens the page's side content. Pages keep their state when you leave and come back. Signed-out pages share one slim public header. [Resolution](resolutions/decide-app-shell.md) · [Prototype notes](prototypes/app-shell/README.md)

## Not yet specified

- **Missing cards and Owner controls** on the shared components. Their place in the shell is decided: Missing cards is a tab and sits in the mobile More sheet, and Owner controls sits in the avatar menu and the More sheet. Still open is how the dense review queues and review cards read, with wide tables scrolling inside their own containers.
- **Sign-in and loading screens.** These use the slim public header from the shell decision. Still open is the sign-in and code-entry layout, and how loading looks without a flash of the old light screen.
- **The shared component kit.** Which pieces to extract from the workspace (buttons, fields, dialogs, tables, empty, loading and error states, toasts), and how the old `web/src/style.css` and the old pages' CSS are retired. The shell prototype found that `style.css` restyles every `button`, `input`, `label` and `main`, so it must be retired or scoped.
- **Rollout and verification.** The order pages move into the shell, and how browser tests and axe checks cover every page.
- **Reconciling the workspace tickets.** [Workspace: Shell, design variables and Location sidebar](https://github.com/ry-cen/prizecheck/issues/102) through [Workspace: Cutover, accessibility pass and prototype removal](https://github.com/ry-cen/prizecheck/issues/114) are still open, but the cutover appears to have landed on `dev`. The spec needs to know what's actually done.

## Out of scope

- Packaging as an Electron (or other desktop) app. The shell only keeps that door open.
- User-chosen themes and a light theme, deferred by [Decide responsive visual system](https://github.com/ry-cen/prizecheck/issues/47).
- New features beyond the Deck List UI.
- Renaming code identifiers from "workspace" to "collection".
- Fixing the Location-switch flicker, tracked in [Workspace flashes gray placeholder tiles and jumps in size on every Location switch](https://github.com/ry-cen/prizecheck/issues/121).
