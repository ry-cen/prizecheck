import type { ReactNode, SelectHTMLAttributes } from "react";
import { ChevronDown } from "lucide-react";
import { FIELD_LABEL, SELECT } from "./control";
import { Icon } from "./Icon";

type Props = Omit<SelectHTMLAttributes<HTMLSelectElement>, "className"> & {
  /** The visible label above the select, which is also its accessible name. */
  label: string;
  /** Keep the label for assistive technology only (a select in a table cell). */
  labelHidden?: boolean;
  /** The <option> elements. */
  children: ReactNode;
};

/** A native select (ADR 0012) with its label: 30 px tall on desktop and 44 px on a phone. It stays a real
 * <select>, so the platform's own picker opens on phones. */
export function Select({ label, labelHidden, children, ...rest }: Props) {
  return (
    <label className={FIELD_LABEL}>
      <span className={labelHidden ? "sr-only" : undefined}>{label}</span>
      <SelectBox {...rest}>{children}</SelectBox>
    </label>
  );
}

/**
 * A bare native select in the kit's look, for a select whose label is laid out another way. The platform's arrow is
 * hidden and the kit's chevron (the same one the filter chips use) sits inside the right edge, with the same inset
 * as the text on the left. `className` replaces the box (SELECT) for a select that isn't full width.
 */
export function SelectBox({
  className = SELECT,
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className="relative flex min-w-0 items-center">
      <select className={className} {...rest}>
        {children}
      </select>
      <Icon
        icon={ChevronDown}
        size={14}
        className="pointer-events-none absolute right-2 text-text-muted"
      />
    </span>
  );
}
