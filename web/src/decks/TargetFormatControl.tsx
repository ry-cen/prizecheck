import type { RefObject } from "react";
import { ChevronDown } from "lucide-react";
import type { FormatCheck } from "../format_checks_generated";
import { Icon } from "../ui/Icon";
import { Menu } from "../ui/Menu";
import {
  formatLabel,
  issueCount,
  statusOf,
  TARGET_FORMATS,
  type TargetFormat,
} from "./targetFormat";

type Props = {
  /** The Target Format shown: the Deck's, or the one a change in flight asks for. */
  value: TargetFormat;
  /** The Target Format's result as of today, or null while a change is in flight. */
  result: FormatCheck | null;
  /** A change is in flight: further choices are ignored until it settles. */
  busy: boolean;
  onChange: (format: TargetFormat) => void;
  onOpenResult: () => void;
  /** The result button, for focus return when the results dialog closes. */
  resultRef: RefObject<HTMLButtonElement | null>;
};

/** ", 2 issues" after a result that isn't legal; nothing after a legal one. */
const words = (result: FormatCheck) =>
  result.status === "legal" ? "" : `, ${issueCount(result)}`;

const STATUS_TEXT: Record<FormatCheck["status"], string> = {
  legal: "text-accent-strong",
  not_legal: "text-danger",
  unknown: "text-text-muted",
};

// Every box property a browser styles on a button is set here, so both parts match the kit's controls.
const PART =
  "box-border m-0 h-control cursor-pointer border-0 bg-transparent font-sans text-control font-medium phone:h-control-phone";

/**
 * The deck header's "Standard · ✓ Legal" control, with a chevron after the Format (#178): one rounded group holding the Target Format as a
 * kit menu button (owner decision 2026-10-14: a styled menu, not the native select) and the result as a button
 * that opens the results dialog. The menu lists the three Formats as menuitemradio items, the Deck's checked;
 * it opens on the checked one, and arrow keys, Home, End, Enter and Escape work as in every kit Menu. While a
 * change is in flight the menu still opens, but a choice is ignored until it settles. Both parts are 30 px tall
 * on desktop and 44 px on a phone, and so are the menu's items; on a narrow phone or with larger text the result wraps
 * under the Format inside the group rather than run off the screen. The result's status is said in words; its mark
 * and colour only repeat it.
 */
export function TargetFormatControl({
  value,
  result,
  busy,
  onChange,
  onOpenResult,
  resultRef,
}: Props) {
  const status = result ? statusOf(result.status) : null;
  const label = formatLabel(value);
  return (
    <div
      role="group"
      aria-label="Target Format and result"
      aria-busy={busy || undefined}
      className="box-border inline-flex max-w-full flex-wrap items-center rounded-round border border-border-strong bg-surface-raised"
    >
      <Menu
        label={`Target Format: ${label}`}
        align="start"
        triggerClassName={`${PART} inline-flex min-w-0 items-center gap-1 whitespace-nowrap rounded-l-round pl-3 pr-1 text-text hover:bg-surface-selected aria-expanded:bg-surface-selected`}
        trigger={
          <>
            {label}
            <Icon icon={ChevronDown} size={14} className="text-text-muted" />
          </>
        }
        items={TARGET_FORMATS.map((format) => ({
          label: format.label,
          checked: format.value === value,
          onSelect: () => {
            if (!busy && format.value !== value) onChange(format.value);
          },
        }))}
      />
      <span aria-hidden="true" className="px-0.5 text-text-subtle">
        ·
      </span>
      <button
        ref={resultRef}
        type="button"
        disabled={!result}
        aria-label={
          result && status
            ? `${status.text}${words(result)}. Show the ${label} result`
            : `Checking the ${label} result`
        }
        onClick={onOpenResult}
        className={`${PART} inline-flex items-center gap-1 whitespace-nowrap rounded-r-round pl-1 pr-3 hover:bg-surface-selected disabled:cursor-progress ${
          result ? STATUS_TEXT[result.status] : "text-text-muted"
        }`}
      >
        {result && status ? (
          <>
            <span aria-hidden="true">{status.mark}</span>
            {status.text}
          </>
        ) : (
          "Checking…"
        )}
      </button>
      {/* Says the new result once a change settles; the button's own text changes silently. */}
      <span role="status" className="sr-only">
        {result && status && !busy
          ? `${label}: ${status.text}${words(result)}`
          : ""}
      </span>
    </div>
  );
}
