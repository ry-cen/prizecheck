# App shell prototype

Supports [Prototype the app shell and navigation](https://github.com/ry-cen/prizecheck/issues/122). This is development-only design evidence, not production code. The decision it led to is [the app shell resolution](../../resolutions/decide-app-shell.md).

## Where the code is

The prototype code lives on the throwaway branch `prototype/app-shell`, not on `feature/app-redesign` or `dev`. To run it, check out that branch, run `npm run dev:web -- --port 5185 --strictPort`, then open `/collection?prototype=shell&variant=A` (or `B` or `C`).

- Code: `web/src/prototypes/app-shell/`.
- Mount: a dev-only lazy import in `web/src/main.tsx`.
- Data: in-memory sample data only. No API or auth server is needed.

## Variants

- **A — Top tabs + bottom bar (chosen).** Desktop has page tabs in the header and an avatar menu with Owner controls and Sign out. Mobile has a bottom tab bar (Collection, Decks, Catalog, More), and ☰ opens the page's side content.
- **B — Icon rail + context panel.** A narrow page rail sits beside a second column with the page's side content. On mobile, one ☰ drawer holds both.
- **C — One sidebar tree.** Pages are sections in a single sidebar, and the open page expands its own tree. The header is a breadcrumb.

The switcher bar also offers **keep pages mounted** (compare keeping or losing state on return), **signed in** (the slim public header on a Published Deck) and **owner**.

## Owner verdict — 2026-10-12

1. Variant A.
2. Pages keep their state when the collector leaves and comes back.
3. Owner controls and Sign out go in the avatar menu (desktop) and the More sheet (mobile).
4. No concerns with the header slot.

## Checks — 2026-10-12

- **Build.** `npx tsc -p web/tsconfig.json --noEmit` passed. `vite build` passed, and `dist/` contains none of the prototype's markers (`proto-switcher`, `ps-unified`, `AppShellPrototype`).
- **Desktop and mobile.** All three variants render at 1280×800 and 375×812.
- **Keeping state.** At 375 px with keep pages mounted on, Variant A restored a 400 px scroll position and the selection after a visit to Decks and back.
- **No overflow.** At 375 px, no element passed the viewport edge on Collection, Owner controls or the public Published Deck page. The Owner review table scrolls sideways inside its own container.
- **Not verified.** Real touch gestures and the ☰ drawers' focus return.

## Finding for the redesign

The old global `web/src/style.css` styles every `button`, `input`, `label` and `main` element. Its rules pushed margins, padding and colours into the prototype until they were reset. The redesign must retire or scope that file, or every new component will fight it.
