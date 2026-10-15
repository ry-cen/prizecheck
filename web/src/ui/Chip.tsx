import type { ReactNode, Ref } from "react";
import { ChevronDown } from "lucide-react";
import { Icon } from "./Icon";

type Props = {
  /** Whether the filter is on (aria-pressed). */
  selected: boolean;
  onChange: (selected: boolean) => void;
  disabled?: boolean;
  children: ReactNode;
};

// The button is the 44 px phone tap area; the inner span is the drawn chip.
const OUTER =
  "group m-0 box-border inline-flex h-chip shrink-0 cursor-pointer items-center justify-center border-0 bg-transparent p-0 font-sans disabled:cursor-default disabled:opacity-45 phone:h-tap phone:min-w-tap";
const INNER =
  "box-border inline-flex h-chip items-center gap-1 whitespace-nowrap rounded-round border px-2.5 text-meta group-hover:border-control-outline phone:h-control";
const OFF = "border-border-strong text-text-muted";
const ON = "border-accent-border bg-accent-wash text-accent-strong";

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
      className={OUTER}
    >
      <span
        className={`${INNER} border-border-strong text-text-muted group-aria-pressed:border-accent-border group-aria-pressed:bg-accent-wash group-aria-pressed:text-accent-strong`}
      >
        {children}
      </span>
    </button>
  );
}

/**
 * A chip that opens a picker (Catalog's set picker, #173): drawn and sized like Chip, with a chevron. It is not a
 * toggle; it shows the selected look while a value is chosen (`active`) and says it opens a dialog.
 */
export function PickerChip({
  active,
  onClick,
  buttonRef,
  children,
}: {
  active: boolean;
  onClick: () => void;
  buttonRef?: Ref<HTMLButtonElement>;
  children: ReactNode;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      aria-haspopup="dialog"
      onClick={onClick}
      className={OUTER}
    >
      <span className={`${INNER} ${active ? ON : OFF}`}>
        {children}
        <Icon icon={ChevronDown} size={14} />
      </span>
    </button>
  );
}
