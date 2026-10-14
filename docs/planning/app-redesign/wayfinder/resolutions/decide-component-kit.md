# Resolution — Shared component kit

**Owner confirmed:** 2026-10-12

**Ticket:** [Decide the shared component kit](https://github.com/ry-cen/prizecheck/issues/137)

**Evidence:** the three prototypes ([app shell](../prototypes/app-shell/README.md), [deck experience](../prototypes/deck-experience/README.md), [Catalog search](../prototypes/catalog-search/README.md)), `web/src/style.css`, `web/src/tokens.css` and the workspace CSS on `dev`.

**ADR:** [0012 Style the app with Tailwind on our own tokens](../../../../adr/0012-style-the-app-with-tailwind-on-our-tokens.md)

## Decision

### Styling

- **Tailwind CSS v4** is the styling layer, through `@tailwindcss/vite`.
- **`tokens.css` becomes Tailwind's `@theme`.** Tailwind's own palette, type scale and radii are switched off. The only colours are the Prize gold roles (`bg-surface-raised`, `text-muted` and so on). A lint check bans arbitrary values such as `bg-[#123]`. Themes still switch with `data-theme` on `<html>`.
- **`style.css` is deleted.** Tailwind's Preflight is the reset. One small base stylesheet adds the page background, text colour, `color-scheme: dark` and one global focus ring. Bare `button`, `input`, `select` and heading elements get **no look**. Every visible control comes from the kit.
- How old pages coexist with the new styles while they move is for [Decide rollout and verification](https://github.com/ry-cen/prizecheck/issues/141).

### Where the kit lives

- **Kit components are React components in `web/src/ui/`,** styled with Tailwind utilities. They carry behaviour as well as looks.
- **Pages** use kit components for shared pieces and write their own layout (grids, sidebars, spacing) in utilities.
- **Collection is rewritten.** Every `ws-` rule in `web/src/workspace/*.css` becomes utilities or kit components, and those CSS files are deleted. The fixed heights the gallery's layout model depends on (`--tile-names-height`, `--tile-caption-height`, `--tile-price-height` and the tile sizes) stay as theme variables. Component and directory names (`web/src/workspace/`) are unchanged, as the map's Notes already say.

### Size scale

| | Desktop | Phone (≤760 px) |
| --- | --- | --- |
| Buttons, search, selects, steppers | 30 px | 44 px |
| Chips, pills, segmented switches | 24 px | drawn at 24–30 px, with a 44 px tap area |
| Tile quick buttons (+, ±) | 26 px | drawn at 36 px, with a 44 px tap area |
| Type | 13 px controls · 12 px meta · 11 px captions · 14 px body | same |

- This replaces today's 36 px `--control-height`, and adds a 13 px size to the type scale.
- The invisible tap-area extension on phones is a kit behaviour, not per-page CSS.

### Shared components (`web/src/ui/`)

A piece is shared when two or more pages use it, or when it carries behaviour that is easy to get wrong.

- **Button:** primary, secondary, quiet and danger, plus icon-only.
- **Chip:** a toggleable filter.
- **Pill:** a status badge, including one that opens something ("Standard ▾ · ✓ Legal").
- **Segmented:** Spread / Stacked / List, Browse / Add, Owned / All.
- **SearchField**, **Select** and **Stepper** (− N +).
- **Dialog:** one component on the native `<dialog>`. It's centred on desktop and a bottom sheet on phones, so pages never choose. It handles the focus trap, focus return to the opener, Escape and the scrim. This takes over what the workspace's four dialogs and two drawers each do by hand today.
- **Menu:** the avatar menu, Export and the ⋯ menus.
- **Toast:** one host for the whole app, with an Undo action.
- **EditionTile** (Catalog, the deck library, the popup's Edition list) and **CopyTile** (Collection, the deck's Spread view). They share the card art, badges, the dashed and ghost states, and the Names line.
- **CardPopup:** the card, Prev and Next, Editions, ownership and price, with page-specific actions passed in. Catalog and the deck builder both use it.
- **ScrollTable:** a table that scrolls inside its own container, never the page.
- **EmptyState**, **LoadingState** (tile-shaped placeholders) and **ErrorState** (with Retry).
- **Icon:** a wrapper for `lucide-react` that sets size and `aria-hidden`. It replaces the text glyphs (☰ ⋯ ✓ ↻ $ ‹ › + −), whose rendering differs between devices.

No headless component library is used.

### Page-local pieces

- **Collection:** the Location tree, Manage locations drag, the inspector, selection rings and the marquee.
- **Decks:** Deck List lines, the Pick List rows, the format results content and the deck header rows.
- **Catalog:** the Add-mode bar and its tray.
- **Owner controls and Missing cards:** their tables' contents, inside ScrollTable.

### Variant Descriptor

This settles the placement the [old Collection page audit](audit-old-collection-page.md) left to this ticket.

- **On tiles:** EditionTile and CopyTile show it on the Names line's second line, after set and number (`Paldea Evolved · 185 · Reverse Holo`), truncating with an ellipsis. With Names off, it isn't drawn. There's no badge, and no tile height changes.
- **Always in the tile's accessible name and hover title,** whether or not Names is on.
- **In the inspector:** a **Variant** row under set and number.
- "Unspecified Variant" is shown in the same places, worded exactly that way.

The owner considered and declined an always-visible **?** badge on Unspecified Variant tiles. Unspecified Editions come from catalog source gaps or ambiguity, or from Missing card reports where the variant isn't known.

## Not decided here

- How old pages and `style.css` coexist during the move, and in what order pages move: [Decide rollout and verification](https://github.com/ry-cen/prizecheck/issues/141).
- Whether a component gallery or visual checks verify the kit: also [Decide rollout and verification](https://github.com/ry-cen/prizecheck/issues/141).
