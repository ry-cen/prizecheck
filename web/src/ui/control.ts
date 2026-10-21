/*
 * Class strings the kit's form controls share (ADR 0012 sizes: 30 px on desktop, 44 px on a phone). Every box
 * property the browser would otherwise style (margin, border, padding, font, colour, box sizing) is set here,
 * so a control looks the same with or without Preflight (on since #184). Never combine two classes that set the
 * same property (h-control with h-auto, border-0 with border): Tailwind doesn't promise their order.
 */

/** The box every control shares, without its horizontal padding. */
const BOX =
  "box-border m-0 w-full min-w-0 rounded-control border border-control-outline bg-bg font-sans text-control font-normal text-text placeholder:text-text-subtle disabled:opacity-45";

/** Everything but the height: inputs, selects and text areas. */
export const CONTROL_BOX = `${BOX} px-2`;

/** A one-line control: a text input, a search field or a select. */
export const CONTROL = `${CONTROL_BOX} h-control phone:h-control-phone`;

/** A select: the one-line box with the platform's arrow hidden and room on the right for SelectBox's chevron. */
export const SELECT = `${BOX} h-control phone:h-control-phone cursor-pointer appearance-none pl-2 pr-7`;

/** The visible label above a control. The label element wraps the control, so the control takes its name. */
export const FIELD_LABEL =
  "flex min-w-0 flex-col gap-1 text-meta font-medium text-text-muted";
