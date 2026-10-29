import type { ComponentPropsWithRef } from "react";

type Props = Omit<
  ComponentPropsWithRef<"input">,
  "className" | "type" | "children"
> & {
  /** The accessible name. Name what the box does, since the visible label is the row's. */
  "aria-label": string;
};

/**
 * The kit's checkbox: a native checkbox inside a tap area (30 px on desktop, 44 px on a phone), so the
 * browser supplies the keyboard, focus and checked semantics. It has no visible text of its own; put it in a
 * SettingRow, whose name and note sit beside it. The label wraps the input, so a click anywhere in the area
 * toggles it, and the accessibility audit measures the label as the target.
 */
export function Checkbox(props: Props) {
  return (
    <label className="box-border inline-flex min-h-control min-w-control cursor-pointer items-center justify-center has-[:disabled]:cursor-default has-[:disabled]:opacity-45 phone:min-h-tap phone:min-w-tap">
      <input
        {...props}
        type="checkbox"
        className="m-0 size-4 shrink-0 cursor-[inherit] accent-accent"
      />
    </label>
  );
}
