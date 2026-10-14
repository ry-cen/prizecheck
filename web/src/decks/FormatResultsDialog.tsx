import { useEffect, useId, useState, type RefObject } from "react";
import {
  getDeckFormatChecks,
  type FormatCheck,
  type FormatIssue,
} from "../format_checks_generated";
import { Dialog } from "../ui/Dialog";
import { Pill } from "../ui/Pill";
import { TextField } from "../ui/TextField";
import { editionText, type DeckLine } from "./deckListModel";
import {
  cardIssues,
  dayText,
  deckIssues,
  formatLabel,
  resultFor,
  statusOf,
} from "./targetFormat";

type Props = {
  open: boolean;
  onClose: () => void;
  returnFocus: RefObject<HTMLElement | null>;
  deckId: string;
  /** The Deck's Target Format and its result as of today, from the last Deck read or command. */
  targetFormat: string;
  today: FormatCheck;
  disclaimer: string;
  /** The Deck List's lines, to name the cards a card-level issue concerns. */
  lines: readonly DeckLine[];
};

type Other =
  | { kind: "loading"; on: string }
  | { kind: "ready"; on: string; result: FormatCheck }
  | { kind: "failed"; on: string };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The Target Format's result (#178): the "as of" date (today unless the collector picks another, with the
 * future-rules note for a later day), the deck-level and card-level issues with their plain reasons, and the
 * rules version and the advisory disclaimer. A date other than today asks the format-checks read for the Target
 * Format on that day; the header keeps today's result.
 */
export function FormatResultsDialog({
  open,
  onClose,
  returnFocus,
  deckId,
  targetFormat,
  today,
  disclaimer,
  lines,
}: Props) {
  const [asOf, setAsOf] = useState(today.evaluated_on);
  const [other, setOther] = useState<Other | null>(null);
  const headingBase = useId();

  // Each opening starts on today.
  useEffect(() => {
    if (open) {
      setAsOf(today.evaluated_on);
      setOther(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open || asOf === today.evaluated_on || !ISO_DATE.test(asOf)) {
      setOther(null);
      return;
    }
    const controller = new AbortController();
    setOther({ kind: "loading", on: asOf });
    getDeckFormatChecks(
      deckId,
      { format: targetFormat, asOf },
      controller.signal
    )
      .then((checks) => {
        const result = resultFor(checks, targetFormat);
        setOther(
          result
            ? { kind: "ready", on: asOf, result }
            : { kind: "failed", on: asOf }
        );
      })
      .catch(() => {
        if (!controller.signal.aborted) setOther({ kind: "failed", on: asOf });
      });
    return () => controller.abort();
  }, [open, asOf, today.evaluated_on, deckId, targetFormat]);

  const label = formatLabel(targetFormat);
  const shown =
    other === null ? today : other.kind === "ready" ? other.result : null;
  const names = new Map(
    lines.map((line) => [
      line.line.edition_id,
      `${line.line.name} (${editionText(line)})`,
    ])
  );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`${label} result`}
      closeLabel="Close result"
      returnFocus={returnFocus}
    >
      <div className="flex flex-col gap-4 text-body">
        <div className="max-w-48">
          <TextField
            type="date"
            label="As of"
            value={asOf}
            required
            onChange={(event) => setAsOf(event.target.value)}
          />
        </div>
        <div role="status" className="flex flex-col gap-2">
          {other?.kind === "loading" ? (
            <p className="m-0 text-text-muted">Checking {dayText(other.on)}…</p>
          ) : other?.kind === "failed" ? (
            <p className="m-0 text-warning">
              The result for {dayText(other.on)} couldn't be checked. Check your
              connection and try again.
            </p>
          ) : shown ? (
            <Summary result={shown} label={label} />
          ) : null}
        </div>
        {shown && (
          <>
            {shown.notes.map((note) => (
              <p key={note} className="m-0 text-meta text-warning">
                {note}
              </p>
            ))}
            <IssueList
              id={`${headingBase}-deck`}
              title="Deck issues"
              issues={deckIssues(shown)}
              names={names}
              namesLines={false}
            />
            <IssueList
              id={`${headingBase}-card`}
              title="Card issues"
              issues={cardIssues(shown)}
              names={names}
              namesLines
            />
            <p className="m-0 text-caption text-text-subtle">
              Rules version {shown.rules_version}
            </p>
          </>
        )}
        <p className="m-0 text-caption text-text-subtle">{disclaimer}</p>
      </div>
    </Dialog>
  );
}

function Summary({ result, label }: { result: FormatCheck; label: string }) {
  const status = statusOf(result.status);
  return (
    <p className="m-0 flex flex-wrap items-center gap-2">
      <Pill tone={status.tone}>
        <span aria-hidden="true">{status.mark}&nbsp;</span>
        {status.text}
      </Pill>
      <span>
        in {label} as of {dayText(result.evaluated_on)}
        {result.issues.length === 0 && result.status === "legal"
          ? ". No issues found."
          : ""}
      </span>
    </p>
  );
}

function IssueList({
  id,
  title,
  issues,
  names,
  namesLines,
}: {
  id: string;
  title: string;
  issues: readonly FormatIssue[];
  names: ReadonlyMap<string, string>;
  /** Card-level issues name their cards; a deck-level issue is about the whole deck. */
  namesLines: boolean;
}) {
  if (!issues.length) return null;
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <h3 id={id} className="m-0 text-meta font-semibold text-text-muted">
        {title}
      </h3>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {issues.map((issue) => {
          const cards = namesLines
            ? issue.lines.map((line) => names.get(line)).filter(Boolean)
            : [];
          return (
            <li
              key={`${issue.code}:${issue.reason}`}
              className="flex flex-col gap-1 rounded-control border border-border p-2"
            >
              <span className="flex flex-wrap items-center gap-2">
                <Pill
                  tone={issue.effect === "not_legal" ? "bad" : "unverified"}
                >
                  {issue.effect === "not_legal" ? "Not legal" : "Unknown"}
                </Pill>
                <span className="min-w-0 wrap-anywhere">{issue.reason}</span>
              </span>
              {cards.length > 0 && (
                <span className="text-meta text-text-muted wrap-anywhere">
                  {cards.join(", ")}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
