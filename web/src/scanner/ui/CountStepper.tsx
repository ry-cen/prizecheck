import { Minus, Plus, Trash2 } from "lucide-react";
import { Icon } from "../../ui/Icon";

const STEP =
  "m-0 box-border inline-flex h-full w-control cursor-pointer items-center justify-center border-0 bg-transparent p-0 font-sans text-text-muted enabled:hover:bg-surface-selected enabled:hover:text-text disabled:cursor-default disabled:opacity-45 phone:w-control-phone first:rounded-l-control last:rounded-r-control";

/**
 * A tray row's copies: − N +, where the minus becomes a bin at 1 and removes the row. Built like the kit's Stepper
 * (30 px, 44 px on a phone), but its minus has to change its icon and name, which the kit's does not.
 */
export function CountStepper({
  name,
  count,
  max,
  disabled,
  onSet,
  onRemove,
}: {
  /** The card's name, for the buttons' names. */
  name: string;
  count: number;
  max: number;
  disabled?: boolean;
  onSet: (count: number) => void;
  onRemove: () => void;
}) {
  return (
    <div
      role="group"
      aria-label={`Copies of ${name}`}
      className="box-border inline-flex h-control shrink-0 items-stretch rounded-control bg-surface-raised outline outline-1 -outline-offset-1 outline-border-strong phone:h-control-phone"
    >
      <button
        type="button"
        aria-label={
          count <= 1 ? `Remove ${name} from the tray` : `One fewer ${name}`
        }
        disabled={disabled}
        onClick={() => (count <= 1 ? onRemove() : onSet(count - 1))}
        className={STEP}
      >
        <Icon icon={count <= 1 ? Trash2 : Minus} />
      </button>
      <output
        aria-live="polite"
        className="box-content inline-flex min-w-8 items-center justify-center px-1 text-control tabular-nums text-text"
      >
        {count}
      </output>
      <button
        type="button"
        aria-label={`One more ${name}`}
        disabled={disabled || count >= max}
        onClick={() => onSet(count + 1)}
        className={STEP}
      >
        <Icon icon={Plus} />
      </button>
    </div>
  );
}
