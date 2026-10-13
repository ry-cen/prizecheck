/*
 * Class strings the kit's form controls share (ADR 0012 sizes: 30 px on desktop, 44 px on a phone). There is
 * no Preflight while style.css exists, so every box property the browser would otherwise style (margin,
 * border, padding, font, colour, box sizing) is set here. Never combine two classes that set the same
 * property (h-control with h-auto, border-0 with border): Tailwind doesn't promise their order.
 */

/** Everything but the height: inputs, selects and text areas. */
export const CONTROL_BOX =
  "box-border m-0 w-full min-w-0 rounded-control border border-border-strong bg-bg px-2 font-sans text-control text-text placeholder:text-text-subtle disabled:opacity-45";

/** A one-line control: a text input, a search field or a select. */
export const CONTROL = `${CONTROL_BOX} h-control phone:h-control-phone`;

/** The visible label above a control. The label element wraps the control, so the control takes its name. */
export const FIELD_LABEL =
  "flex min-w-0 flex-col gap-1 text-meta font-medium text-text-muted";
