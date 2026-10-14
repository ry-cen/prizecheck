import type { ReactNode } from "react";

type Props = {
  /** Whether the filter is on (aria-pressed). */
  selected: boolean;
  onChange: (selected: boolean) => void;
  disabled?: boolean;
  children: ReactNode;
};

/**
 * A toggleable filter chip (ADR 0012). It is drawn at 24 px on desktop and 30 px on a phone. On a phone
 * the button itself is a 44 px box around the drawn chip, so the whole tap area is the button and a
 * scroll container around a row of chips can't clip it (a pseudo-element extension would be clipped).
 */
export function Chip({ selected, onChange, disabled, children }: Props) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      onClick={() => onChange(!selected)}
      className="group m-0 box-border inline-flex h-chip shrink-0 cursor-pointer items-center justify-center border-0 bg-transparent p-0 font-sans disabled:cursor-default disabled:opacity-45 phone:h-tap phone:min-w-tap"
    >
      <span className="box-border inline-flex h-chip items-center gap-1 whitespace-nowrap rounded-round border border-border-strong px-2.5 text-meta text-text-muted group-hover:border-control-outline group-aria-pressed:border-accent-border group-aria-pressed:bg-accent-wash group-aria-pressed:text-accent-strong phone:h-control">
        {children}
      </span>
    </button>
  );
}
