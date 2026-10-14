import type { ReactNode, SelectHTMLAttributes } from "react";
import { CONTROL, FIELD_LABEL } from "./control";

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
      <select className={`${CONTROL} cursor-pointer`} {...rest}>
        {children}
      </select>
    </label>
  );
}
