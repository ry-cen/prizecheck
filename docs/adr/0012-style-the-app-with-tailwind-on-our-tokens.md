# Style the app with Tailwind on our own tokens

**Status:** accepted; planning decision, not yet implemented.

The owner decided this on 2026-10-12, in [Decide the shared component kit](https://github.com/ry-cen/prizecheck/issues/137).

PrizeCheck's web app is styled with **Tailwind CSS v4**, through `@tailwindcss/vite`. The design variables in `web/src/tokens.css` become Tailwind's `@theme`. Tailwind's own palette, type scale and radii are switched off, so the only colours, sizes and radii that exist are ours. A lint check rejects arbitrary values such as `bg-[#123]`. Themes still switch with `data-theme` on `<html>`, because the utilities read the variables.

Shared pieces are React components in `web/src/ui/`, styled with utilities. Pages write their own layout in utilities. The global `web/src/style.css` is deleted. Tailwind's Preflight is the reset, plus one small base stylesheet for the page background, text colour, `color-scheme` and the focus ring. Bare elements get no look.

Collection's existing plain CSS (the `ws-*.css` files in `web/src/workspace/`) is rewritten into utilities and kit components, not kept beside them. The fixed tile heights the gallery's layout model depends on stay as theme variables.

## Considered options

- **Plain CSS files with prefixed classes, the existing `ws-` convention.** Rejected by the owner in favour of Tailwind.
- **CSS Modules per component.** Rejected: a new convention for no gain over Tailwind.
- **Keep Tailwind's default palette and sizes beside our tokens (`@theme inline`).** Rejected: `bg-red-500` and Tailwind's own `text-sm` would keep working, and the visual system's rule that components never hardcode a colour would become a convention rather than a build rule.
- **Keep Collection's CSS and use Tailwind only for new pages.** Rejected by the owner: the app would carry two styling approaches indefinitely.
- **Themed element defaults in a global stylesheet.** Rejected: element-level rules are what forced the workspace's reset block and the prototypes' `:is()` overrides.
