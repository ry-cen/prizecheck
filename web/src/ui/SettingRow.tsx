import type { ReactNode } from "react";

type Props = {
  /** What the setting is called. */
  name: ReactNode;
  /** One line on what it does for the collector, or why it can't change now. */
  note: ReactNode;
  /** Id for the note, so the control can name it in aria-describedby. */
  noteId?: string;
  /** The control, right-aligned: a Checkbox, a Select or a Button. */
  children: ReactNode;
};

/**
 * One setting as a row: its name and a one-line note on the left, its control on the right. Rows stack with
 * a Seam divider between them. The note keeps at least 12 rem; when the control no longer fits beside that,
 * it wraps under the note (flex-wrap), at any width.
 */
export function SettingRow({ name, note, noteId, children }: Props) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border py-3 first:pt-0 last:border-b-0 last:pb-0">
      <div className="flex min-w-0 flex-1 basis-48 flex-col gap-0.5">
        <span className="break-words text-body font-medium text-text">
          {name}
        </span>
        <p id={noteId} className="m-0 break-words text-meta text-text-muted">
          {note}
        </p>
      </div>
      <div className="flex shrink-0 items-center">{children}</div>
    </div>
  );
}
