---
name: PrizeCheck
description: Physical Pokémon card inventory for players who also collect, in a dark, dense, card-first workspace.
colors:
  bg: "#121110"
  surface: "#1a1816"
  surface-raised: "#23201c"
  surface-selected: "#352c1c"
  border: "#38322a"
  border-strong: "#56493a"
  control-outline: "#847766"
  text: "#efebe4"
  text-muted: "#b9b0a3"
  text-subtle: "#9e9588"
  accent: "#e6bd57"
  accent-strong: "#f5dc94"
  accent-border: "#b8913a"
  accent-outline: "#93732f"
  accent-fill: "#5a4519"
  accent-wash: "#e6bd5726"
  on-accent: "#211803"
  art-start: "#3a3122"
  art-end: "#221e19"
  warning: "#f0c987"
  danger: "#eba79f"
  danger-border: "#b0625a"
  danger-fill: "#6f3a35"
  scrim: "#00000099"
typography:
  display:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "24px"
    fontWeight: 600
  heading:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "18px"
    fontWeight: 600
  body:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.45
  control:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: 1
  meta:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "12px"
    fontWeight: 400
  caption:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "11px"
    fontWeight: 500
  label:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "10px"
    fontWeight: 600
    letterSpacing: "1.7px"
  numeric:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "14px"
    fontFeature: "tnum"
rounded:
  control: "7px"
  card: "7px"
  panel: "10px"
  dialog: "14px"
  round: "999px"
spacing:
  "1": "4px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "5": "20px"
  "6": "24px"
  "7": "28px"
  "8": "32px"
  "10": "40px"
  "12": "48px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "30px"
  button-primary-hover:
    backgroundColor: "{colors.accent-strong}"
    textColor: "{colors.on-accent}"
  button-secondary:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.text}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "30px"
  button-secondary-selected:
    backgroundColor: "{colors.surface-selected}"
    textColor: "{colors.accent-strong}"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.text-muted}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "30px"
  button-quiet-hover:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.text}"
  button-danger:
    backgroundColor: "{colors.danger-fill}"
    textColor: "{colors.text}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "30px"
  input:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.text}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "0 8px"
    height: "30px"
  chip:
    backgroundColor: "transparent"
    textColor: "{colors.text-muted}"
    typography: "{typography.meta}"
    rounded: "{rounded.round}"
    padding: "0 10px"
    height: "24px"
  chip-selected:
    backgroundColor: "{colors.accent-wash}"
    textColor: "{colors.accent-strong}"
  pill:
    backgroundColor: "transparent"
    textColor: "{colors.text-muted}"
    typography: "{typography.caption}"
    rounded: "{rounded.round}"
    padding: "0 8px"
    height: "24px"
  nav-item:
    backgroundColor: "transparent"
    textColor: "{colors.text-muted}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "30px"
  nav-item-current:
    backgroundColor: "{colors.surface-selected}"
    textColor: "{colors.accent-strong}"
  dialog:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.dialog}"
    width: "480px"
  toast:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.text}"
    typography: "{typography.control}"
    rounded: "{rounded.panel}"
  count-badge:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    typography: "{typography.label}"
    rounded: "{rounded.round}"
    height: "18px"
---

# Design System: PrizeCheck

## Overview

**Creative North Star: "The Deck Box"**

PrizeCheck is a sturdy, compact container built to be used at the table. Like a good deck box, it is dark, plain and well made, and it exists to hold the cards. Card art is the only full colour in the app. Everything around it is a warm near-black stack of surfaces, so the cards are always the brightest thing on screen and the interface recedes behind them.

The system is dense and tactile rather than airy. Controls are small and exact on a desktop (30 px), where collectors spend long sessions sorting and building, and grow to full thumb size on a phone (44 px), where they check a list or confirm a swap at league. Nothing is ornamental: there is no decorative imagery, no gradient except the empty-art placeholder, no motion beyond short state transitions, and no shadow except under the cards and their badges. One accent, Prize Gold, marks what is selected, current or primary, and its scarcity is what makes it legible.

Precision is the brand. Counts, prices, collector numbers and quantities line up in tabular numerals. States such as selected, stale, unavailable and error are always spelled out in words or icons, never by colour alone. The theme layer is built to swap: every colour is a role, so future energy-type themes (Grass, Fire, Water and the rest) change values without touching a component.

**Key Characteristics:**

- Dark only, warm near-black surfaces layered by tone, not by shadow.
- One accent (Prize Gold) for selection, the current view and the primary action.
- Card art is the only saturated colour; the chrome stays neutral around it.
- System font throughout; tabular numerals for every count, price and number.
- Compact desktop controls (30 px) that become 44 px tap targets on a phone.
- Small, consistent corners: 7 px on controls and cards, 10 px on panels, 14 px on dialogs.

## Colors

A warm, low-chroma brown-black neutral stack with one gold accent and a muted rose for danger.

### Primary

- **Prize Gold** (accent): the selected tile ring, the primary button, count badges, the wordmark's star and filled selection checks. It is the one colour that means "this is chosen" or "do this".
- **Pale Gold** (accent-strong): text and icons on a selected surface, the current navigation item, the hover state of the primary button. Gold you read rather than gold you fill with.
- **Antique Brass** (accent-border): the border of selected chips, toggled buttons and positive Pills.
- **Tarnished Brass** (accent-outline): dashed outlines for valid drop targets and copies stored elsewhere.
- **Deep Ochre** (accent-fill) and **Gold Wash** (accent-wash, gold at 15% opacity): quiet gold backgrounds behind a selected chip or an accent region, used without muted text on top.
- **Ink on Gold** (on-accent): text on any Prize Gold fill.

### Neutral

- **Deck Box Black** (bg): the page and the inside of form controls.
- **Felt** (surface): panels, the phone tab bar, dialogs and drawers.
- **Raised Felt** (surface-raised): secondary buttons, toasts, menus, tile badges and hover fills.
- **Selected Umber** (surface-selected): the background of the current view, a pressed toggle and an open menu trigger.
- **Seam** (border): dividers and the borders of panels that don't identify a control.
- **Stitch** (border-strong): borders of buttons, chips, dialogs and raised containers.
- **Control Outline** (control-outline): the border of inputs and selects, whose outline is the only thing that shows where an empty field is, and a button's or chip's outline on hover; guaranteed at least 3:1 against every surface.
- **Bone** (text): primary text.
- **Parchment** (text-muted): secondary text, field labels, idle navigation and quiet buttons.
- **Faded Parchment** (text-subtle): set and collector-number lines, uppercase section labels, placeholders.
- **Sleeve Brown** (art-start to art-end): the gradient of a card-shaped placeholder when art is missing or loading.

### Status

- **Amber** (warning): warning Pills and attention borders.
- **Rose** (danger), **Rosewood** (danger-border) and **Oxblood** (danger-fill): error text, the danger button's border and its fill.

### Named Rules

**The Card Is the Colour Rule.** Saturated colour belongs to the card art. The chrome stays in the neutral stack and Prize Gold; never add a second accent hue to the interface.

**The Gold Means Chosen Rule.** Prize Gold appears only on what is selected, current, primary or counted. If gold marks something else, it stops telling collectors what they picked.

**The Role, Not the Hex Rule.** Components use colour roles, never literal values; a guardrail rejects arbitrary colour values in class names. A new theme is one new set of role values and touches no component.

## Typography

**Display Font:** system-ui (with -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif)
**Body Font:** the same system stack
**Label/Mono Font:** none; numerals use the system font's tabular figures

**Character:** The platform's own sans, used at small sizes with a tight scale. It feels native to every device and spends no attention on itself, which leaves the cards to carry the personality. A distinctive wordmark font may come later with a logo.

### Hierarchy

- **Display** (600, 24px): page titles, the open Location's name, and headline totals such as a Deck's card count.
- **Heading** (600, 18px): dialog titles and section headings inside a page.
- **Body** (400, 14px, 1.45 line height where the page sets it): running text, list rows and descriptions.
- **Control** (500, 13px): buttons, inputs, selects and navigation items; the primary button uses 600.
- **Meta** (400, 12px): secondary details, chip text, menu headers and field labels (500).
- **Caption** (500, 11px): tile names, Pills and the phone tab bar's labels.
- **Label** (600, 10px, 1.7px letter spacing, uppercase): small section labels above groups of controls, and bold count badges.

### Named Rules

**The Tabular Numbers Rule.** Every count, price, collector number and quantity uses tabular numerals so columns and totals line up.

**The Weight Carries Hierarchy Rule.** Hierarchy comes from semibold (600) against regular, plus the colour step from Bone to Parchment to Faded Parchment, not from large size jumps. The largest size in the app is 24 px.

## Layout

The signed-in app is a shell with a sticky 64 px header (wordmark, the main views, account) on desktop and, on a phone, a header that scrolls away plus a fixed 56 px bottom tab bar. The Collection workspace is three columns: a 212 px Location tree, the card gallery, and a 310 px inspector that narrows to 220 px at the compact breakpoint. The gallery packs card tiles at a 245:342 card aspect in two sizes (small 110 px, medium 145 px; 90 px and 120 px on a phone), with as many per row as fit, a 20 px row gap and a 12 px column gap. Its side gutter is 30 px, tightening to 20 px from 1550 px and 16 px from 2200 px, and 14 px on a phone.

All spacing sits on a 4 px scale (4 to 48 px). Values off the scale are named layout variables because a spec fixes them.

Breakpoints are literal media queries: phone up to 760 px, compact up to 1100 px, wide from 1550 px and extra wide from 2200 px. On a phone, dialogs become bottom sheets (up to 85% of the viewport height, square bottom corners) and controls grow to 44 px.

**The Two Densities Rule.** Desktop is dense (30 px controls, 24 px chips) because collectors sort and build there for long sessions; a phone gets 44 px targets because it is used one-handed at an event. Never ship a phone control under 44 px of tap area, even when the drawn shape is smaller.

## Elevation & Depth

Depth comes from tonal layering: Deck Box Black, then Felt, then Raised Felt, each a small step lighter, separated by Seam or Stitch borders. Panels, dialogs, toasts and menus are flat at rest. Shadows appear only on the cards themselves and on the small badges that sit on them, so a card reads like a physical card lying on felt; a dialog's depth comes from its scrim.

### Shadow Vocabulary

- **Badge lift** (`box-shadow: 0 1px 4px #00000088`): count and check badges sitting on top of card art, so they read against any artwork.
- **Card lift** (`box-shadow: 0 4px 12px #00000044`): under card art in gallery tiles and the inspector.
- **Selected ring** (`box-shadow: 0 0 0 3px var(--color-bg), 0 0 0 6px var(--color-accent)`): not elevation but a ring outside a selected tile, with a dark gap so it stays visible against gold card borders.

### Named Rules

**The Flat Felt Rule.** Containers are flat; only cards and their badges cast a shadow. If a container needs to stand out, raise its surface a tone or give it a Stitch border; don't add a drop shadow.

## Shapes

Corners are small and consistent: 7 px on controls and card tiles, 10 px on panels, toasts and the inspector, and 14 px on dialogs. Chips, Pills, badges and avatars are fully round. Drawers and phone bottom sheets lose the corners on the edges they attach to. Borders are 1 px solid; dashed borders and outlines mean something specific (a valid drop target, a copy stored elsewhere, an unverified status) and are never decorative.

## Components

### Buttons

Compact, flat and plainly labelled, with an optional leading icon.

- **Shape:** gently rounded (7px), 30 px tall on desktop and 44 px on a phone, 12 px side padding (16 px on a phone). Icon-only buttons are square and always carry an accessible label.
- **Primary:** Prize Gold fill and border with Ink on Gold text at weight 600. One per view, for the action that moves the task forward.
- **Secondary (default):** Raised Felt with a Stitch border and Bone text; the border brightens to Control Outline on hover.
- **Quiet:** no fill or border, Parchment text; hover fills Raised Felt and brightens the text to Bone.
- **Danger:** Oxblood fill with a Rosewood border; the border turns Rose on hover.
- **Selected state:** a pressed toggle or a trigger whose menu is open switches to Selected Umber with an Antique Brass border and Pale Gold text.
- **Disabled:** 45% opacity; a busy button shows 60% opacity and a progress cursor.
- **Focus:** the global 2 px Prize Gold outline with a 2 px offset.

### Checkboxes

- **Style:** the native checkbox, 16 px, drawn in Prize Gold, inside a tap area of 30 px on desktop and 44 px on a phone. It has no visible text of its own; its setting's name sits in a Setting row, and its accessible name says what it does.
- **State:** checked shows the setting is on. A saving checkbox shows the value just asked for and carries `aria-busy`; a refused save shows the saved value again. Disabled is 45% opacity.

### Setting rows

- **Layout:** a name in Body text (500) with a one-line Meta note in Parchment beneath it, left-aligned; the control (Checkbox, Select or Button) right-aligned. Rows are separated by Stitch dividers with 12 px of padding above and below.
- **Wrapping:** the note keeps at least 12 rem; the control wraps under it only when it no longer fits beside it, at any width. Long names break instead of overflowing.
- **Notes:** say what the setting does for the collector, or why it can't change now (a disabled control puts its reason here, not in a tooltip).

### Chips

- **Style:** fully round, 24 px drawn height (30 px on a phone, inside a 44 px tap box), Meta text, a Stitch border and Parchment text.
- **State:** a selected filter chip gets Gold Wash behind it, an Antique Brass border and Pale Gold text. A picker chip adds a chevron and shows the selected look while a value is chosen.

### Pills (status badges)

- **Style:** fully round, 24 px tall at every width, Caption text, outline only.
- **Tones:** ok (Antique Brass border, Pale Gold text), warn (Amber), bad (Rosewood border, Rose text), unverified (dashed Control Outline), neutral (Stitch, Parchment). The text always states the status; the tone only repeats it. A Pill is never pressable.

### Inputs / Fields

- **Style:** Deck Box Black inside a Control Outline border (3:1 or better on every surface, as WCAG 1.4.11 asks of a field's boundary), 7 px corners, 30 px tall (44 px on a phone), Control text, Faded Parchment placeholders. Selects hide the platform arrow and draw their own chevron.
- **Label:** a visible Meta label (500, Parchment) above the control, wrapping it.
- **Focus:** the global Prize Gold focus ring.
- **Disabled:** 45% opacity.

### Navigation

- **Desktop:** the header's main views are quiet text buttons in Parchment; the current view gets Selected Umber and Pale Gold text. Count badges (Prize Gold, 18 px, bold 10 px numerals) sit beside a view's label.
- **Phone:** a fixed Felt tab bar at the bottom with icon-over-label items in Caption text; the current item turns Pale Gold.
- **Wordmark:** "PrizeCheck" in uppercase bold 12 px with 2 px letter spacing, after a Prize Gold four-pointed star (✦).

### Dialogs, drawers and sheets

- **Style:** Felt, Stitch border, 14 px corners, 480 px wide on desktop, over a 60% black scrim. A header row holds a Heading title and a quiet close button above a Seam divider.
- **Variants:** left and right drawers take the full height with square corners; on a phone, a centred dialog becomes a bottom sheet.

### Scroll bars

With a mouse or trackpad (`(hover: hover) and (pointer: fine)`, at any window width) the browser's scroll bar is hidden everywhere, so a screen lays out the same whether or not it scrolls. An overlay bar replaces it: a 6 px rounded thumb in `--color-scroll-thumb` (Parchment, the system text colour in forced-colors mode) on a 12 px rail that takes no layout space and no clicks except on the thumb. It shows only while the region can scroll, fades in while the pointer is over the region or it scrolls, and can be dragged. Every scrolling region is a `ScrollArea` (or, for a textarea or `<pre>` that scrolls itself, carries an `OverlayScrollbarFor`); `check_guardrails.py` rejects `overflow-auto` classes elsewhere. Touch devices keep their own overlay bars and get no rail. The page's bar is `DocumentScrollbar`, below the sticky header and above the phone tab bar.

### Toast

A single bar at the bottom centre (above the tab bar on a phone): Raised Felt, Stitch border, 10 px corners, Control text, and an inline action such as Undo in semibold Pale Gold.

### Card Tile (signature component)

The heart of the app: one copy of a Card Edition drawn as a card.

- **Art:** the card image at its 245:342 aspect with 7 px corners, or a Sleeve Brown gradient placeholder showing the card's name when art is missing.
- **Lines under the art:** an optional Names block (name in Caption; set code and collector number in tabular 10 px Faded Parchment), a price line, and a caption, each at a fixed height so the gallery's layout stays exact.
- **Badges:** round 24 px badges with a 2 px Deck Box Black ring and Badge lift: the copy count on Raised Felt at the top left, and a filled Prize Gold check at the top right when selected.
- **States:** selected (the dark gap and gold ring outside the art, plus the check badge), elsewhere (a dashed Tarnished Brass outline inside the art), missing (40% opacity).

## Do's and Don'ts

### Do:

- **Do** use colour roles (`--color-*` and their Tailwind names) for every colour; Prize Gold is the default and only shipped theme.
- **Do** keep Prize Gold for what is selected, current, primary or counted.
- **Do** use tabular numerals for counts, prices, collector numbers and quantities.
- **Do** give every phone control at least 44 px of tap area and every desktop target at least 24 px.
- **Do** show selected, stale, unavailable and error states with words or icons as well as colour.
- **Do** keep text at 4.5:1 and identifying outlines at 3:1 against bg, surface, raised and selected surfaces.
- **Do** keep transitions at 150 ms or less (`--motion-duration`, 120 ms with `cubic-bezier(0.2, 0, 0, 1)`), and none under reduced motion.
- **Do** use card-shaped placeholder tiles for loading, not spinners.

### Don't:

- **Don't** hardcode a colour, or add a second accent hue to the chrome.
- **Don't** add drop shadows to panels, toasts, menus or dialogs; layer by tone.
- **Don't** use Tailwind's default palette, type scale, radii or breakpoints; they are reset and generate nothing.
- **Don't** decorate: no ornamental imagery, gradients (outside the art placeholder) or motion for its own sake.
- **Don't** use dashed borders or outlines decoratively; they mean drop target, stored elsewhere or unverified.
- **Don't** let collectors pick custom colours: themes (including any future light theme) are preset, contrast-checked role sets.
