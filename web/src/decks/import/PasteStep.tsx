import type { Ref } from "react";
import { PageHeader } from "../../shell/PageHeader";
import { Button } from "../../ui/Button";
import { Select } from "../../ui/Select";
import { TextArea, TextField } from "../../ui/TextField";
import { TARGET_FORMATS, type TargetFormat } from "../targetFormat";
import { plural } from "./importModel";
import type { ImportReviewState } from "./useImportReview";

const LINK =
  "inline-flex h-control items-center gap-1 rounded-control px-2 text-control font-medium text-accent-strong no-underline hover:bg-surface-raised phone:h-control-phone";

type Props = {
  text: string;
  onText: (text: string) => void;
  name: string;
  onName: (name: string) => void;
  nameMessage: string;
  targetFormat: TargetFormat;
  onTargetFormat: (format: TargetFormat) => void;
  state: ImportReviewState;
  canReview: boolean;
  onReview: () => void;
  onAllDecks: () => void;
  textAreaRef: Ref<HTMLTextAreaElement>;
  nameRef: Ref<HTMLInputElement>;
};

/**
 * Import a decklist, step one (#212): paste a TCG Live or Limitless list, name the new Deck and choose its Target
 * Format. The server reads the paste as it is typed and answers the live count; Review opens the check.
 */
export function PasteStep({
  text,
  onText,
  name,
  onName,
  nameMessage,
  targetFormat,
  onTargetFormat,
  state,
  canReview,
  onReview,
  onAllDecks,
  textAreaRef,
  nameRef,
}: Props) {
  const totals = state.review?.totals;
  const noName = !name.trim();
  return (
    <main className="mx-auto box-border flex max-w-7xl flex-col gap-6 px-7 py-6 phone:px-4 phone:py-4">
      <div className="flex flex-col gap-2">
        <a
          href="/decks"
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey) return;
            event.preventDefault();
            onAllDecks();
          }}
          className={`${LINK} self-start`}
        >
          ‹ Decks
        </a>
        <PageHeader title="Import a decklist" />
        <p className="m-0 text-body text-text-muted">
          Paste a list from Pokémon TCG Live or Limitless. You'll check every
          line before anything is saved.
        </p>
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_20rem] items-start gap-6 phone:grid-cols-1">
        <section aria-label="Paste" className="flex flex-col gap-2">
          <TextArea
            ref={textAreaRef}
            label="Decklist"
            rows={16}
            spellCheck={false}
            value={text}
            onChange={(event) => onText(event.target.value)}
          />
          <p
            role="status"
            className="m-0 flex flex-wrap items-center gap-2 text-meta text-text-muted"
          >
            {state.error ? (
              <>
                {state.error}
                {state.code !== "IMPORT_TOO_LONG" &&
                  state.code !== "IMPORT_TOO_MANY_LINES" && (
                    <Button onClick={state.retry}>Retry</Button>
                  )}
              </>
            ) : !text.trim() ? (
              "Section headers and Total Cards lines are fine; their numbers aren't used."
            ) : !totals ? (
              "Reading the list…"
            ) : (
              `${plural(totals.card_lines, "card line")} · ${plural(Number(totals.cards), "card")}${
                totals.ignored > 0
                  ? ` · ${plural(totals.ignored, "other line")} will be ignored`
                  : ""
              }`
            )}
          </p>
        </section>
        <aside aria-label="Destination" className="flex flex-col gap-3">
          <div>
            <p className="m-0 text-meta text-text-muted">Put it in</p>
            <p className="m-0 text-body font-semibold">A new Deck</p>
          </div>
          <TextField
            ref={nameRef}
            label="Deck name"
            required
            maxLength={120}
            value={name}
            onChange={(event) => onName(event.target.value)}
          />
          {nameMessage && (
            <p role="status" className="m-0 text-body text-warning">
              {nameMessage}
            </p>
          )}
          <Select
            label="Target Format"
            value={targetFormat}
            onChange={(event) =>
              onTargetFormat(event.target.value as TargetFormat)
            }
          >
            {TARGET_FORMATS.map((format) => (
              <option key={format.value} value={format.value}>
                {format.label}
              </option>
            ))}
          </Select>
          <Button
            variant="primary"
            aria-disabled={!canReview || undefined}
            onClick={() => {
              if (canReview) onReview();
            }}
          >
            {totals && totals.card_lines > 0
              ? `Review ${plural(totals.card_lines, "line")}`
              : "Review"}
          </Button>
          {totals && totals.card_lines > 0 && noName && (
            <p className="m-0 text-meta text-warning">Name the Deck first.</p>
          )}
        </aside>
      </div>
    </main>
  );
}
