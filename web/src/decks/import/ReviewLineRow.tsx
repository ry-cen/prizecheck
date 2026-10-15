import type { Ref } from "react";
import type { ReviewLine } from "../../decks_generated";
import { Button } from "../../ui/Button";
import { Pill } from "../../ui/Pill";
import { EditionChooser } from "./EditionChooser";
import {
  lineName,
  needsYou,
  noteText,
  partText,
  statusText,
  type Pick,
} from "./importModel";
import { LineResolver } from "./LineResolver";

type Props = {
  line: ReviewLine;
  /** Which panel is open under this line, if any. */
  open: "fix" | "edition" | null;
  onToggle: (kind: "fix" | "edition") => void;
  onPick: (pick: Pick) => void;
  onDrop: () => void;
  onRestore: () => void;
  onEdition: (editionId: string) => void;
  /** The ref of the row's action button (Fix, Edition or Restore), so focus can return to it. */
  actionRef: Ref<HTMLButtonElement>;
};

/**
 * One pasted line in the review (#212): its quantity, the card it resolved to, a status Pill, the line as pasted, the
 * Deck List line(s) it becomes and why it needs the collector. Fix, Edition or Restore sits on the right.
 */
export function ReviewLineRow({
  line,
  open,
  onToggle,
  onPick,
  onDrop,
  onRestore,
  onEdition,
  actionRef,
}: Props) {
  const flagged = needsYou(line);
  const status = statusText(line);
  const note = noteText(line);
  return (
    <li className="flex flex-col gap-2 border-b border-border py-3 last:border-b-0">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex min-w-0 flex-1 basis-56 flex-col gap-0.5">
          <p className="m-0 text-body">
            <span className="font-semibold tabular-nums">{line.quantity}</span>{" "}
            {lineName(line)}{" "}
            {status && (
              <Pill tone={flagged ? "warn" : "neutral"}>{status}</Pill>
            )}
          </p>
          <p className="m-0 text-meta text-text-muted wrap-anywhere">
            {line.text}
          </p>
          {line.parts.map((part) => (
            <p key={part.edition_id} className="m-0 text-meta">
              {partText(line, part)}
            </p>
          ))}
          {note && (
            <p className={`m-0 text-meta${flagged ? " text-warning" : ""}`}>
              {note}
            </p>
          )}
        </div>
        {line.status === "dropped" ? (
          <Button ref={actionRef} variant="quiet" onClick={onRestore}>
            Restore
          </Button>
        ) : flagged ? (
          <Button
            ref={actionRef}
            aria-expanded={open === "fix"}
            onClick={() => onToggle("fix")}
          >
            {open === "fix" ? "Close" : "Fix"}
          </Button>
        ) : (
          <Button
            ref={actionRef}
            variant="quiet"
            aria-expanded={open === "edition"}
            onClick={() => onToggle("edition")}
          >
            {open === "edition" ? "Close" : "Edition"}
          </Button>
        )}
      </div>
      {open === "fix" && flagged && (
        <LineResolver line={line} onPick={onPick} onDrop={onDrop} />
      )}
      {open === "edition" && line.printing && (
        <EditionChooser line={line} onEdition={onEdition} />
      )}
    </li>
  );
}
