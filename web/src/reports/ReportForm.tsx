import type { FormEvent } from "react";
import { Button } from "../ui/Button";
import { Select } from "../ui/Select";
import { TextArea, TextField } from "../ui/TextField";

export type ReportDraft = {
  kind: "printing" | "edition";
  setId: string;
  setName: string;
  number: string;
  englishName: string;
  printingId: string;
  descriptor: string;
  evidence: string;
  note: string;
};

export const EMPTY_DRAFT: ReportDraft = {
  kind: "printing",
  setId: "",
  setName: "",
  number: "",
  englishName: "",
  printingId: "",
  descriptor: "",
  evidence: "",
  note: "",
};

type Props = {
  draft: ReportDraft;
  onDraft: (change: Partial<ReportDraft>) => void;
  busy: boolean;
  onSubmit: () => void;
};

/**
 * Report a card (#169): today's form on the kit, with the same fields. A Missing Printing names the set ID,
 * set name, collector number and English name; a Missing Edition names its Printing and the physical
 * variant. Both take an evidence link and a note. The page keeps the draft, so it survives a sub-tab or
 * page switch.
 */
export function ReportForm({ draft, onDraft, busy, onSubmit }: Props) {
  function submit(event: FormEvent) {
    event.preventDefault();
    onSubmit();
  }
  return (
    <form
      onSubmit={submit}
      className="box-border flex min-w-0 flex-col gap-3 rounded-panel border border-border bg-surface p-4"
    >
      <h2 className="m-0 text-body font-semibold">
        Report a missing English card
      </h2>
      <p className="m-0 text-meta text-text-muted">
        Reports are private to you and the owner. They do not add a catalog
        record.
      </p>
      <div className="grid grid-cols-2 gap-3 phone:grid-cols-1">
        <Select
          label="Report type"
          value={draft.kind}
          onChange={(event) =>
            onDraft({ kind: event.target.value as ReportDraft["kind"] })
          }
        >
          <option value="printing">Missing Printing</option>
          <option value="edition">Missing Edition</option>
        </Select>
      </div>
      {draft.kind === "printing" ? (
        <div className="grid grid-cols-2 gap-3 phone:grid-cols-1">
          <TextField
            label="Set ID"
            value={draft.setId}
            onChange={(event) => onDraft({ setId: event.target.value })}
            maxLength={80}
          />
          <TextField
            label="Set name"
            value={draft.setName}
            onChange={(event) => onDraft({ setName: event.target.value })}
            maxLength={160}
          />
          <TextField
            label="Collector number"
            value={draft.number}
            onChange={(event) => onDraft({ number: event.target.value })}
            maxLength={80}
          />
          <TextField
            label="English name"
            value={draft.englishName}
            onChange={(event) => onDraft({ englishName: event.target.value })}
            maxLength={160}
          />
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 phone:grid-cols-1">
          <TextField
            label="Printing ID"
            value={draft.printingId}
            onChange={(event) => onDraft({ printingId: event.target.value })}
            required
          />
          <TextField
            label="Physical variant details"
            value={draft.descriptor}
            onChange={(event) => onDraft({ descriptor: event.target.value })}
            placeholder="Finish, foil pattern, stamp, size…"
          />
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 phone:grid-cols-1">
        <TextField
          label="Evidence link"
          type="url"
          value={draft.evidence}
          onChange={(event) => onDraft({ evidence: event.target.value })}
        />
      </div>
      <TextArea
        label="What is missing?"
        value={draft.note}
        onChange={(event) => onDraft({ note: event.target.value })}
        maxLength={2000}
        rows={3}
      />
      <div>
        <Button type="submit" variant="primary" disabled={busy}>
          Send private report
        </Button>
      </div>
    </form>
  );
}
