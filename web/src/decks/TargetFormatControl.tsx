import type { RefObject } from "react";
import type { FormatCheck } from "../format_checks_generated";
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

// No Preflight while style.css exists, so every box property a browser styles on a select or button is set here.
const PART =
  "box-border m-0 h-control cursor-pointer border-0 bg-transparent font-sans text-control font-medium phone:h-control-phone";

/**
 * The deck header's "Standard ▾ · ✓ Legal" control (#178): one rounded group holding the Target Format as a
 * native select (the platform's own picker opens on a phone) and the result as a button that opens the results
 * dialog. Both parts are 30 px tall on desktop and 44 px on a phone. The result's status is said in words; its
 * mark and colour only repeat it.
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
      className="box-border inline-flex max-w-full items-center rounded-round border border-border-strong bg-surface-raised"
    >
      <select
        aria-label="Target Format"
        value={value}
        onChange={(event) => {
          if (!busy) onChange(event.target.value as TargetFormat);
        }}
        className={`${PART} min-w-0 rounded-l-round pl-3 pr-1 text-text`}
      >
        {TARGET_FORMATS.map((format) => (
          <option key={format.value} value={format.value}>
            {format.label}
          </option>
        ))}
      </select>
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
