import { useRef, useState, type ReactNode } from "react";
import { OverlayScrollbarFor } from "./ui/ScrollArea";

export const INLINE_EXPORT_LIMIT_BYTES = 256 * 1024;

export type ExportOutputProps = {
  /** Accessible name of the export section, e.g. "Live export". */
  label: string;
  /** Complete export text, or null when it is not available inline (empty or too large). */
  text: string | null;
  /** Byte length of the complete export; text is shown/copied inline only when <= 256 KiB. */
  byteLength: number;
  /** Download URL used when the export is not inline. */
  downloadHref?: string;
  /** Suggested file name for the download link. */
  downloadName?: string;
  /** True when the export has no cards; shows emptyMessage and disables Copy. */
  empty?: boolean;
  emptyMessage?: string;
  /** Warnings block (caller-rendered), shown above the export. */
  warnings?: ReactNode;
  /** Disclaimer block (caller-rendered), shown below the export. */
  disclaimer?: ReactNode;
  /** Caller status text announced politely (for example "Export is out of date"). */
  status?: string;
  copyLabel?: string;
  downloadLabel?: string;
};

export function ExportOutput({
  label,
  text,
  byteLength,
  downloadHref,
  downloadName,
  empty = false,
  emptyMessage = "No cards",
  warnings,
  disclaimer,
  status,
  copyLabel = "Copy",
  downloadLabel = "Download",
}: ExportOutputProps) {
  // The text box or <pre> that scrolls itself, for its overlay scroll bar.
  const output = useRef<HTMLElement | null>(null);
  // A copy result belongs to the exact text it was attempted for, so a newer
  // export never inherits an earlier "Copied" or failure state.
  const [copyResult, setCopyResult] = useState<{
    text: string;
    failed: boolean;
  } | null>(null);
  const current = copyResult && copyResult.text === text ? copyResult : null;
  const copyFailed = current?.failed ?? false;
  const copyStatus = current
    ? current.failed
      ? "Copy failed. Select the text below and copy it manually."
      : "Copied to clipboard."
    : "";
  const inline =
    !empty && text !== null && byteLength <= INLINE_EXPORT_LIMIT_BYTES;

  async function copy() {
    if (text === null) return;
    const attempted = text;
    setCopyResult(null);
    try {
      await navigator.clipboard.writeText(attempted);
      setCopyResult({ text: attempted, failed: false });
    } catch {
      setCopyResult({ text: attempted, failed: true });
    }
  }

  return (
    <section aria-label={label}>
      {warnings}
      {empty && <p>{emptyMessage}</p>}
      {empty && (
        <button type="button" disabled>
          {copyLabel}
        </button>
      )}
      {!empty && inline && (
        <>
          <button type="button" onClick={() => void copy()}>
            {copyLabel}
          </button>
          {/* The textarea or <pre> scrolls itself (ExportDialog's styles); the box gives its overlay bar a place. */}
          <div className="relative">
            {copyFailed ? (
              <textarea
                ref={(element) => {
                  output.current = element;
                }}
                readOnly
                aria-label={`${label} text`}
                value={text ?? ""}
                rows={12}
                onFocus={(event) => event.currentTarget.select()}
              />
            ) : (
              <pre
                ref={(element) => {
                  output.current = element;
                }}
                aria-label={`${label} text`}
                tabIndex={0}
              >
                {text}
              </pre>
            )}
            <OverlayScrollbarFor
              key={copyFailed ? "area" : "pre"}
              target={output}
              clearGrip={copyFailed}
            />
          </div>
        </>
      )}
      {!empty && !inline && downloadHref && (
        <>
          <p>This export is too large to show here. Download it instead.</p>
          <a href={downloadHref} download={downloadName ?? ""}>
            {downloadLabel}
          </a>
        </>
      )}
      {disclaimer}
      <p role="status">{[status, copyStatus].filter(Boolean).join(" ")}</p>
    </section>
  );
}
