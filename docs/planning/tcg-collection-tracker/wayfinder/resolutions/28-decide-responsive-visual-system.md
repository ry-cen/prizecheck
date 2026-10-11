# Resolution — Responsive visual system

**Owner confirmed:** 2026-10-11

**Ticket:** [Decide responsive visual system](https://github.com/ry-cen/prizecheck/issues/47)

This resolution sets the visual system for PrizeCheck. It builds on [collector workspace selection and presentation](29-decide-collector-workspace-selection-and-presentation.md) and [drag and Location ordering](27-decide-drag-and-location-ordering.md) without reopening them. The [collector workspace spec](../../../collector-workspace/spec.md) carries these decisions into implementation.

## Scope

- There is one shared set of design variables for the whole app: colours, spacing, corner radii and tile sizes.
- The collector workspace adopts them first. Other pages (catalog search, Decks, Published Deck, Discover, sign-in, operations) move onto them when each is redesigned, not as part of the workspace work.

## Colour and themes

- The app is dark only for now. Every colour goes through a variable for its role, never a hardcoded value. The roles are background, surface, raised surface, selected surface, border, strong border, control outline, text, muted text, subtle text, accent, strong accent, accent border, accent outline, accent fill, accent wash, text on accent, artwork placeholder, warning and danger.
- A theme is one set of values for those roles, selected by an attribute on the app root.
- **Prize gold** is the default theme. **Grass** (the original sage green) and **Water** (blue) are alternative themes, already in the prototype.
- **User-chosen themes** are planned but not built in this work. When built, they will be preset themes named after Pokémon TCG energy types: Grass, Fire, Water, Lightning, Psychic, Fighting, Darkness, Metal, Dragon and Colorless. There are no custom colours, because user-picked colours would need contrast checking to stay accessible. Where the choice is stored (browser or account) is decided when it is built, alongside the other deferred account preferences.
- A light theme can be added later as another set of values.

## Type

- Use the system font. Counts, prices, collector numbers and quantities use tabular numerals.
- A distinctive wordmark font may come later with a logo.

## Shape and spacing

- Spacing follows a 4 px scale.
- Controls and cards have 7 px corners; panels and dialogs have 10–15 px.
- Tiles come in two sizes, small and medium. Cards per row follow the available width.

## Accessibility and motion baseline

- Text and controls meet WCAG 2.2 AA contrast in every theme. Control outlines that identify a control use their own variable at 3:1 or better against every surface; decorative dividers may be subtler.
- Every interactive element shows a visible focus ring.
- Targets are at least 44 px on mobile and at least 24 px on desktop.
- Transitions such as drawers and highlights last 150 ms or less, and none run when the device asks for reduced motion.
- States such as selected, stale, unavailable and error are never shown by colour alone.

## Presentation decisions

- **Selected tiles.** A dark gap, then an accent ring, plus a filled check badge inside the card's top-right corner. The gap keeps the ring visible against yellow or gold card borders, and the badge keeps selection from relying on colour.
- **Names line.** The Names toggle shows the card name and, on a second smaller line, its set and collector number. Each tile's hover title and accessible label always include the set and number.
- **Loading.** The gallery shows card-shaped placeholder tiles, not a spinner. Prices keep their existing loading and unavailable labels.
- **Errors.** Errors appear inline where they happened, in the dialog or form. A failed card operation keeps the selection and names the affected Location.
- **Stale data.** A slim banner above the gallery says the collection changed in another tab and offers Reload. Nothing refreshes silently.
- **Success and Undo.** A toast at the bottom centre on desktop, above the Actions strip on mobile.

## Carried forward

- The owner noted that the "Move here" confirmation button in Manage locations looks a bit odd. It is to be revisited in the implementation's visual pass.

## Evidence

The [themes and selected tiles prototype notes](../prototypes/collector-workspace/README.md#themes-and-selected-tiles--2026-10-11) show the three themes, the contrast results, the selected-tile treatment and the set and number line.
