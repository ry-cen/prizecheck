import type { InputHTMLAttributes } from "react";
import { Search } from "lucide-react";
import { CONTROL } from "./control";
import { Icon } from "./Icon";

type Props = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "type" | "className"
> & {
  /** The search box's accessible name, for example "Search cards". */
  label: string;
};

/** A search box (ADR 0012): a magnifier, then the input, 30 px tall on desktop and 44 px on a phone. Its
 * name comes from `label`; a page that wants a visible label puts its own text beside it. */
export function SearchField({ label, ...rest }: Props) {
  return (
    <div className="relative flex min-w-0 items-center">
      <Icon
        icon={Search}
        className="pointer-events-none absolute left-2 text-text-subtle"
      />
      <input
        type="search"
        aria-label={label}
        className={`${CONTROL} pl-8`}
        {...rest}
      />
    </div>
  );
}
