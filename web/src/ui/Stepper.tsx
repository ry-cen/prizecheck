import { Minus, Plus } from "lucide-react";
import { Icon } from "./Icon";

type Props = {
  /** What the number counts, for example "Quantity". It names the group and both buttons. */
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  disabled?: boolean;
};

const STEP =
  "m-0 box-border inline-flex h-full w-control cursor-pointer items-center justify-center border-0 bg-transparent p-0 font-sans text-text-muted enabled:hover:bg-surface-selected enabled:hover:text-text disabled:cursor-default disabled:opacity-45 phone:w-control-phone first:rounded-l-control last:rounded-r-control";

/** − N + (ADR 0012): 30 px tall on desktop and 44 px on a phone. The buttons are "Decrease <label>" and
 * "Increase <label>", and each stops at its limit. The number is announced as it changes. */
export function Stepper({
  label,
  value,
  onChange,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
  disabled,
}: Props) {
  return (
    <div
      role="group"
      aria-label={label}
      className="box-border inline-flex h-control items-stretch rounded-control bg-surface-raised outline outline-1 -outline-offset-1 outline-border-strong phone:h-control-phone"
    >
      <button
        type="button"
        aria-label={`Decrease ${label}`}
        disabled={disabled || value <= min}
        onClick={() => onChange(Math.max(min, value - 1))}
        className={STEP}
      >
        <Icon icon={Minus} />
      </button>
      <output
        aria-live="polite"
        className="inline-flex min-w-8 items-center justify-center px-1 text-control tabular-nums text-text"
      >
        {value}
      </output>
      <button
        type="button"
        aria-label={`Increase ${label}`}
        disabled={disabled || value >= max}
        onClick={() => onChange(Math.min(max, value + 1))}
        className={STEP}
      >
        <Icon icon={Plus} />
      </button>
    </div>
  );
}
