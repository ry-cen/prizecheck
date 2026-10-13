import type { ComponentPropsWithRef, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Icon } from "./Icon";

export type ButtonVariant = "primary" | "secondary" | "quiet" | "danger";

type Shared = Omit<ComponentPropsWithRef<"button">, "className"> & {
  variant?: ButtonVariant;
  /** Layout only (margins, alignment, flex). Never colours, sizes or borders: those are the variant's. */
  className?: string;
};
type TextButton = Shared & {
  /** An icon before the text. */
  icon?: LucideIcon;
  label?: never;
  children: ReactNode;
};
type IconOnlyButton = Shared & {
  icon: LucideIcon;
  /** The accessible name of an icon-only button. */
  label: string;
  children?: never;
};

const BASE =
  "box-border m-0 inline-flex h-control cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-control border font-sans text-control font-medium leading-none disabled:cursor-default disabled:opacity-45 phone:h-control-phone";
const TEXT = "px-3 phone:px-4";
const ICON_ONLY = "w-control p-0 phone:w-control-phone";
const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "border-accent bg-accent font-semibold text-on-accent enabled:hover:border-accent-strong enabled:hover:bg-accent-strong",
  secondary:
    "border-border-strong bg-surface-raised text-text enabled:hover:border-control-outline",
  quiet:
    "border-transparent bg-transparent text-text-muted enabled:hover:bg-surface-raised enabled:hover:text-text",
  danger:
    "border-danger-border bg-danger-fill text-text enabled:hover:border-danger",
};

/**
 * The kit's button (ADR 0012): primary, secondary, quiet and danger, with text or icon-only. 30 px tall on
 * desktop and 44 px on a phone. It is type="button" unless a type is given. An icon-only button needs a
 * label, which becomes its accessible name.
 */
export function Button({
  variant = "secondary",
  icon,
  label,
  className,
  type = "button",
  children,
  ...rest
}: TextButton | IconOnlyButton) {
  const iconOnly = label !== undefined;
  return (
    <button
      type={type}
      aria-label={iconOnly ? label : undefined}
      className={`${BASE} ${iconOnly ? ICON_ONLY : TEXT} ${VARIANTS[variant]}${className ? ` ${className}` : ""}`}
      {...rest}
    >
      {icon && <Icon icon={icon} />}
      {children}
    </button>
  );
}
