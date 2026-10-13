/*
 * Control looks for Collection's dialogs and Actions strip (#165), at the kit sizes: 30 px, 44 px on a
 * phone. They stand in for the kit's Button (#167) until it lands. Each string leaves out `display`, so a
 * caller adds `inline-flex`, or `hidden phone:inline-flex`, without two classes setting one property.
 */

const BUTTON_BASE =
  "box-border h-control cursor-pointer items-center justify-center gap-1 whitespace-nowrap rounded-control border px-3 font-sans text-control disabled:cursor-default disabled:opacity-40 aria-disabled:cursor-progress aria-disabled:opacity-60 phone:h-control-phone";

/** A plain button (Cancel, Details, Actions). */
export const BUTTON = `${BUTTON_BASE} border-control-outline bg-surface-raised font-medium text-text hover:bg-surface-selected`;

/** The confirming button of a dialog (Move, Create location). */
export const PRIMARY_BUTTON = `${BUTTON_BASE} border-accent bg-accent font-semibold text-on-accent`;

/** A confirming button that removes something (Inventory Removal). */
export const DANGER_BUTTON = `${BUTTON_BASE} border-danger-border bg-danger-fill font-semibold text-text`;

/** A text field or select, full width. */
export const FIELD =
  "box-border h-control w-full min-w-0 rounded-control border border-control-outline bg-surface-raised px-3 font-sans text-body text-text placeholder:text-text-subtle phone:h-control-phone";

/** A dialog's button row: Cancel, then the confirming button, at the right. */
export const BUTTON_ROW = "flex justify-end gap-2";
