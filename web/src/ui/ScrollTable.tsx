import type { ReactNode } from "react";

type Props = {
  /** The accessible name of the scrolling region, for example "Health checks". Give each table on a page
   * a name no other region's name contains. */
  label: string;
  /** The table's <thead> and <tbody>. */
  children: ReactNode;
};

/**
 * A table that scrolls sideways inside its own box, never the page (ADR 0012). The box is a focusable,
 * labelled region, so a keyboard user can scroll it with the arrow keys. Cells don't wrap; a page that
 * needs a wrapping cell sets whitespace-normal on it.
 *
 * The box is also a CSS inline-size container: a review card in a row under an item (#168) can be as wide
 * as the table's visible area and stay pinned to its left edge with `sticky left-0 w-[100cqw]`. Because of
 * that containment, put a ScrollTable in normal block flow or a flex column, never a flex row, where it
 * would shrink to nothing.
 *
 * The box is `relative` so absolutely positioned descendants (sr-only header text, `Select labelHidden`)
 * stay inside the scroll box and can't widen the page.
 */
export function ScrollTable({ label, children }: Props) {
  return (
    <div
      role="region"
      aria-label={label}
      tabIndex={0}
      className="@container relative box-border max-w-full overflow-x-auto rounded-control border border-border"
    >
      {/* Cells are box-content: 32 px plus their padding and rule, the 41 px rows they had before Preflight (#184). */}
      <table className="w-full border-collapse whitespace-nowrap text-meta text-text [:where(&)>tbody>tr>td]:box-content [:where(&)>tbody>tr>td]:h-8 [:where(&)>tbody>tr>td]:border-b [:where(&)>tbody>tr>td]:border-border [:where(&)>tbody>tr>td]:px-2.5 [:where(&)>tbody>tr>td]:py-1 [:where(&)>tbody>tr>td]:align-middle [:where(&)>thead>tr>th]:box-content [:where(&)>thead>tr>th]:h-8 [:where(&)>thead>tr>th]:border-b [:where(&)>thead>tr>th]:border-border [:where(&)>thead>tr>th]:bg-surface [:where(&)>thead>tr>th]:px-2.5 [:where(&)>thead>tr>th]:py-1 [:where(&)>thead>tr>th]:text-left [:where(&)>thead>tr>th]:font-medium [:where(&)>thead>tr>th]:text-text-muted [:where(&)>tbody>tr:last-child>td]:border-b-0">
        {children}
      </table>
    </div>
  );
}
