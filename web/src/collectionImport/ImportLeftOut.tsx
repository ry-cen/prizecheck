import { Fragment, useRef, useState } from "react";
import {
  collectionImportLeftOutHref,
  type CollectionImportLeftOut,
} from "../collection_import_generated";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { exampleText, LEFT_OUT_LABELS, rowsText } from "./importText";

type Props = {
  importId: string;
  /** The import is a pasted list (#234): Download gives its lines as text. */
  lines: boolean;
  /** The summary's left-out rows, one entry per reason that has any. */
  leftOut: CollectionImportLeftOut[];
};

const PANEL =
  "box-border flex flex-col gap-2 rounded-panel border border-border bg-surface p-4";
// The skipped rows' download link's look: a 44 px tap area on a phone.
const LINK =
  "inline-flex min-h-(--target-pointer) items-center text-meta text-accent underline underline-offset-2 hover:text-accent-strong phone:min-h-tap";

/** Collection Import's Left out panel (#231): how many rows were left out for each reason, in plain words, with View
 * (a dialog listing the first few of each, as the file wrote them) and Download (every left-out row in the file's own
 * columns). Nothing shows when nothing was left out. */
export function ImportLeftOut({ importId, lines, leftOut }: Props) {
  const [open, setOpen] = useState(false);
  const view = useRef<HTMLButtonElement>(null);
  if (leftOut.length === 0) return null;
  const href = collectionImportLeftOutHref(importId);
  return (
    <section aria-labelledby="import-left-out-heading" className={PANEL}>
      <h2
        id="import-left-out-heading"
        className="m-0 text-heading font-semibold"
      >
        Left out
      </h2>
      <p className="m-0 text-meta text-text-muted">
        PrizeCheck can&apos;t hold these rows, so they aren&apos;t imported.
      </p>
      <dl className="m-0 grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 text-body">
        {leftOut.map((entry) => (
          <Fragment key={entry.reason}>
            <dt className="text-text-muted">{LEFT_OUT_LABELS[entry.reason]}</dt>
            <dd className="m-0 text-right tabular-nums">{entry.rows}</dd>
          </Fragment>
        ))}
      </dl>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          ref={view}
          aria-label="View left-out rows"
          aria-haspopup="dialog"
          onClick={() => setOpen(true)}
        >
          View
        </Button>
        <a
          className={LINK}
          href={href}
          download={lines ? "left-out-rows.txt" : "left-out-rows.csv"}
          aria-label="Download left-out rows"
        >
          Download
        </a>
      </div>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Left out of this import"
        closeLabel="Close left-out rows"
        returnFocus={view}
      >
        <div className="flex flex-col gap-4">
          {leftOut.map((entry) => (
            <section
              key={entry.reason}
              aria-labelledby={`import-left-out-${entry.reason}`}
              className="flex flex-col gap-1"
            >
              <h3
                id={`import-left-out-${entry.reason}`}
                className="m-0 text-body font-semibold"
              >
                {LEFT_OUT_LABELS[entry.reason]} · {rowsText(entry.rows)}
              </h3>
              <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-meta text-text-muted">
                {entry.examples.map((example, index) => (
                  <li key={index} className="wrap-anywhere">
                    {exampleText(example)}
                  </li>
                ))}
                {entry.rows > entry.examples.length && (
                  <li>and {entry.rows - entry.examples.length} more</li>
                )}
              </ul>
            </section>
          ))}
          <a
            className={`${LINK} self-start`}
            href={href}
            download={lines ? "left-out-rows.txt" : "left-out-rows.csv"}
          >
            Download these rows
          </a>
        </div>
      </Dialog>
    </section>
  );
}
