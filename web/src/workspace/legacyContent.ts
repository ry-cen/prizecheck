/*
 * Looks for the old shared components that Collection still shows inside its own panels: the Deck cost and
 * export panels (DeckCost, DeckLiveExport, DeckMassEntryExport, ExportOutput) and a Reviewed Edition correction
 * (EditionCorrections). The old light pages render the same components, so their markup stays as it is;
 * Collection styles their plain elements from the panel around them with descendant variants. Until #166 the
 * workspace CSS did this. They go when #181 (the Deck banner) and the corrections' own redesign replace these
 * panels. (#175 replaced the Add cards form with Catalog's Add mode.)
 *
 * There is no Preflight while style.css exists, so every property the browser would otherwise style is set.
 */

/** Plain buttons inside: the kit's secondary button (ui/Button.tsx), 30 px tall, 44 px on a phone. */
export const OLD_BUTTONS =
  "[&_button]:m-0 [&_button]:box-border [&_button]:inline-flex [&_button]:min-h-control [&_button]:cursor-pointer [&_button]:items-center [&_button]:justify-center [&_button]:rounded-control [&_button]:border [&_button]:border-solid [&_button]:border-border-strong [&_button]:bg-surface-raised [&_button]:px-3 [&_button]:font-sans [&_button]:text-control [&_button]:font-medium [&_button]:text-text [&_button:disabled]:cursor-default [&_button:disabled]:opacity-45 phone:[&_button]:min-h-tap phone:[&_button]:px-4";

/** Plain inputs and selects inside: the kit's control box (ui/control.ts), 30 px tall, 44 px on a phone. */
export const OLD_FIELDS =
  "[&_input]:m-0 [&_input]:box-border [&_input]:h-control [&_input]:min-w-0 [&_input]:rounded-control [&_input]:border [&_input]:border-solid [&_input]:border-border-strong [&_input]:bg-bg [&_input]:px-2 [&_input]:font-sans [&_input]:text-control [&_input]:text-text phone:[&_input]:h-control-phone [&_select]:m-0 [&_select]:box-border [&_select]:h-control [&_select]:min-w-0 [&_select]:cursor-pointer [&_select]:rounded-control [&_select]:border [&_select]:border-solid [&_select]:border-border-strong [&_select]:bg-bg [&_select]:px-2 [&_select]:font-sans [&_select]:text-control [&_select]:text-text phone:[&_select]:h-control-phone";

/** Paragraphs and headings inside take no browser margin; links take the accent. */
export const OLD_TEXT =
  "[&_h2]:m-0 [&_h3]:m-0 [&_h4]:m-0 [&_p]:m-0 [&_a]:text-accent [&_a]:underline-offset-2 [&_a:hover]:text-accent-strong";
