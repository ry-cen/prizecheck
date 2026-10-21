/*
 * Class strings for the signed-out screens (#163), at the kit sizes (ADR 0012): 30 px controls on desktop and
 * 44 px on a phone. The buttons and fields mirror the kit Button and TextField from #167, which was built in
 * parallel; once both have landed, the <button>s and fields here move onto those components. The links drawn as
 * buttons stay: the kit Button is a <button>.
 *
 * Every box property the browser would style is set here, as in the kit (written before Preflight came on in
 * #184). Never combine two classes that set the same property (font-medium with font-semibold, border-0 with border):
 * Tailwind doesn't promise their order.
 */

const BUTTON =
  "box-border m-0 inline-flex h-control cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-control border px-3 font-sans text-control leading-none no-underline phone:h-control-phone phone:px-4";

/** The main action: gold. */
export const PRIMARY = `${BUTTON} border-accent bg-accent font-semibold text-on-accent hover:border-accent-strong hover:bg-accent-strong`;

/** A second action beside a primary one. */
export const SECONDARY = `${BUTTON} border-border-strong bg-surface-raised font-medium text-text hover:border-control-outline`;

/** A header link: muted text, gold while it is the current page. */
export const QUIET = `${BUTTON} border-transparent bg-transparent font-medium text-text-muted hover:bg-surface-raised hover:text-text aria-[current=page]:text-accent-strong`;

/** The visible label above a field. The label wraps the field, so the field takes its text as its name. */
export const FIELD_LABEL =
  "flex min-w-0 flex-col gap-1 text-meta font-medium text-text-muted";

/** A one-line field. */
export const FIELD =
  "box-border m-0 h-control w-full min-w-0 rounded-control border border-control-outline bg-bg px-2 font-sans text-control text-text phone:h-control-phone";

/** The centred page area under the public header (and inside the shell for a signed-in dead end). */
export const CENTRED_MAIN =
  "box-border flex flex-1 items-start justify-center px-5 pb-10 pt-[10vh] phone:px-4 phone:pt-6";

/** The centred card: 400 px on desktop, the full width between the page margins on a phone. */
export const CARD =
  "box-border flex w-full max-w-100 flex-col gap-4 rounded-dialog border border-border bg-surface p-7 shadow-[0_12px_40px_var(--color-shadow)] phone:max-w-none phone:p-5 phone:shadow-none";
