import { Fragment, useEffect, useId, useRef, useState } from "react";
import {
  decideAttributeReport,
  decideAttributes,
  getAttributeEvidence,
  type AttributeEvidence,
  type AttributeReportView,
} from "../metadata_generated";
import { Button } from "../ui/Button";
import { ScrollTable } from "../ui/ScrollTable";
import { Select } from "../ui/Select";
import { TextArea, TextField } from "../ui/TextField";
import {
  ATTRIBUTE_ROWS,
  EVOLVES_FROM_AFTER,
  correctionFrom,
  decisionError,
  draftFrom,
  parseTypes,
  proposalText,
  safeLink,
  showValue,
  stillQueued,
  type Draft,
} from "./attributeValues";
import { CARD_HEADING, ReviewCard } from "./ReviewQueue";

/** A row header in the attribute table, sized like the ScrollTable's own cells. */
const ROW_HEADER =
  "h-8 border-b border-border px-2.5 py-1 text-left align-middle font-medium";

type Props = {
  /** The queue's row: names the card until the fresh evidence arrives. */
  item: AttributeEvidence;
  onClose: () => void;
  /** A decision or report decision was recorded. `removed` when the Printing no longer belongs in the queue. */
  onDone: (message: string, removed: boolean, next?: AttributeEvidence) => void;
};

/**
 * The card attributes review card (spec "Review cards", Attributes), inline under its queue row: the derived,
 * corrected and effective value of each attribute, Trainer Type included, and Evolves from (derived only). Then the
 * correction form, the linked collector reports with Ask for information and Reject report, and the decision:
 * reason, review evidence URL, Correct or Remove correction. A confirmed decision closes the
 * linked reports with it. The card reads the Printing's evidence again when it opens, so its decision binds to what
 * it shows.
 */
export function AttributeReviewCard({ item, onClose, onDone }: Props) {
  const reportsId = useId();
  const reasonField = useRef<HTMLTextAreaElement>(null);
  const [evidence, setEvidence] = useState<AttributeEvidence | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => draftFrom(null));
  const [decision, setDecision] = useState<"correct" | "remove">("correct");
  const [reason, setReason] = useState("");
  const [evidenceUrl, setEvidenceUrl] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const name = item.name ?? "Unnamed Printing";

  function show(next: AttributeEvidence) {
    setEvidence(next);
    setDraft(draftFrom(next.correction));
    setDecision("correct");
  }

  useEffect(() => {
    let current = true;
    getAttributeEvidence(item.printing_id).then(
      (next) => current && show(next),
      () => current && setLoadFailed(true)
    );
    return () => {
      current = false;
    };
  }, [item.printing_id]);

  const stated = correctionFrom(draft);
  const typesUnreadable = parseTypes(draft.types) === undefined;
  const ready =
    !!reason.trim() &&
    !!evidenceUrl.trim() &&
    (decision === "remove" || (stated.valid && stated.count > 0));

  /** After a recorded decision: the Printing's evidence again, and whether it still belongs in the queue. */
  async function settle(message: string) {
    try {
      const next = await getAttributeEvidence(item.printing_id);
      if (!stillQueued(next)) return onDone(message, true);
      show(next);
      setStatus(message);
      onDone(message, false, next);
    } catch {
      onDone(message, true);
    }
  }

  async function confirm() {
    if (!evidence) return;
    setBusy(true);
    setError("");
    try {
      await decideAttributes({
        printing_id: evidence.printing_id,
        decision,
        ...(decision === "correct" ? { correction: stated.correction } : {}),
        evidence_digest: evidence.evidence_digest,
        evidence_url: evidenceUrl.trim(),
        reason: reason.trim(),
        report_ids: evidence.report_ids,
      });
      await settle(
        decision === "correct"
          ? `Attributes corrected: ${name}.`
          : `Correction removed: ${name}.`
      );
    } catch (failure) {
      setStatus("");
      setError(decisionError(failure));
    } finally {
      setBusy(false);
    }
  }

  async function decideReport(
    report: AttributeReportView,
    choice: "needs_info" | "reject"
  ) {
    setBusy(true);
    setError("");
    try {
      await decideAttributeReport(report.id, {
        decision: choice,
        reason: reason.trim(),
      });
      await settle(
        choice === "reject"
          ? "Report rejected."
          : "Asked the reporter for information."
      );
    } catch (failure) {
      setStatus("");
      setError(decisionError(failure));
    } finally {
      setBusy(false);
    }
  }

  const source = evidence
    ? evidence.source === "manual"
      ? "Manual Printing · no derived attributes"
      : `TCGdex ${evidence.source_id ?? ""} · derived by rules version ${evidence.rules_version ?? "none"}`
    : "Loading attributes…";

  return (
    <ReviewCard title={name} onClose={onClose} focusRef={reasonField}>
      <p className="m-0 text-meta text-text-muted">
        {[item.set_id, item.collector_number].filter(Boolean).join(" · ")}
        {item.set_id || item.collector_number ? " · " : ""}
        {source}
      </p>
      {loadFailed && (
        <p role="alert" className="m-0 text-meta text-danger">
          Unable to load this card's attributes. Close it and try again.
        </p>
      )}
      {evidence && (
        <>
          <ScrollTable label="Attribute values">
            <thead>
              <tr>
                <th scope="col">Attribute</th>
                <th scope="col">Derived</th>
                <th scope="col">Correction</th>
                <th scope="col">Effective</th>
              </tr>
            </thead>
            <tbody>
              {ATTRIBUTE_ROWS.map((row) => {
                const corrected = evidence.correction?.[row.key];
                return (
                  <Fragment key={row.key}>
                    <tr>
                      <th scope="row" className={ROW_HEADER}>
                        {row.label}
                      </th>
                      <td>
                        {evidence.derived
                          ? showValue(row, evidence.derived[row.key])
                          : "None"}
                      </td>
                      <td>
                        {corrected === null || corrected === undefined
                          ? "Not corrected"
                          : showValue(row, corrected)}
                      </td>
                      <td>{showValue(row, evidence.effective[row.key])}</td>
                    </tr>
                    {row.key === EVOLVES_FROM_AFTER && (
                      <tr>
                        <th scope="row" className={ROW_HEADER}>
                          Evolves from
                        </th>
                        <td>{evidence.derived_evolves_from ?? "None"}</td>
                        <td>Not reviewed</td>
                        <td>{evidence.evolves_from ?? "None"}</td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </ScrollTable>

          <fieldset
            disabled={decision === "remove" || busy}
            className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0"
          >
            <legend className={`${CARD_HEADING} p-0`}>Correct to</legend>
            <p className="m-0 text-meta text-text-muted">
              The correction is everything set here. An attribute left at Not
              corrected follows the derived value.
            </p>
            <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3">
              {ATTRIBUTE_ROWS.map((row) =>
                row.kind === "types" ? (
                  <TextField
                    key={row.key}
                    label={row.label}
                    placeholder="Not corrected"
                    value={draft.types}
                    onChange={(event) =>
                      setDraft({ ...draft, types: event.target.value })
                    }
                  />
                ) : (
                  <Select
                    key={row.key}
                    label={row.label}
                    value={draft[row.key]}
                    onChange={(event) =>
                      setDraft({ ...draft, [row.key]: event.target.value })
                    }
                  >
                    <option value="">Not corrected</option>
                    {row.kind === "flag" ? (
                      <>
                        <option value="true">Yes</option>
                        <option value="false">No</option>
                      </>
                    ) : (
                      row.choices.map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))
                    )}
                  </Select>
                )
              )}
            </div>
            <p className="m-0 text-meta text-text-muted">
              Types: leave it empty for not corrected, write none for no types,
              or list the types in printed order, separated by commas.
            </p>
            {typesUnreadable && (
              <p role="alert" className="m-0 text-meta text-danger">
                Types can't be read. Use the type names, such as Fire, Water.
              </p>
            )}
          </fieldset>

          {evidence.reports.length > 0 && (
            <section
              aria-labelledby={reportsId}
              className="flex min-w-0 flex-col gap-2"
            >
              <h4 id={reportsId} className={CARD_HEADING}>
                Collector reports
              </h4>
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {evidence.reports.map((report) => {
                  const link = safeLink(report.evidence_url);
                  return (
                    <li
                      key={report.id}
                      className="flex min-w-0 flex-col gap-1 rounded-control border border-border p-3 text-meta"
                    >
                      <p className="m-0">
                        Proposed: {proposalText(report.proposed)} ·{" "}
                        {report.status === "needs_info"
                          ? "Waiting for the reporter"
                          : "Pending"}{" "}
                        · sent {new Date(report.created_at).toLocaleString()}
                      </p>
                      {report.note && (
                        <p className="m-0 whitespace-pre-wrap wrap-anywhere">
                          {report.note}
                        </p>
                      )}
                      {link && (
                        <p className="m-0 wrap-anywhere">
                          Evidence:{" "}
                          <a
                            href={link}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="text-accent underline underline-offset-2 hover:text-accent-strong"
                          >
                            {link}
                          </a>
                        </p>
                      )}
                      <div className="flex flex-wrap gap-2 pt-1">
                        <Button
                          disabled={busy || !reason.trim()}
                          onClick={() =>
                            void decideReport(report, "needs_info")
                          }
                        >
                          Ask for information
                        </Button>
                        <Button
                          variant="danger"
                          disabled={busy || !reason.trim()}
                          onClick={() => void decideReport(report, "reject")}
                        >
                          Reject report
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
              <p className="m-0 text-meta text-text-muted">
                A confirmed decision closes these reports. Ask for information
                and Reject report need only the reason.
              </p>
            </section>
          )}
        </>
      )}
      <h4 className={CARD_HEADING}>Decision</h4>
      <TextArea
        ref={reasonField}
        label="Reason"
        maxLength={2000}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
      />
      <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3">
        <TextField
          label="Review evidence URL"
          type="url"
          value={evidenceUrl}
          onChange={(event) => setEvidenceUrl(event.target.value)}
        />
        <Select
          label="Decision"
          value={decision}
          disabled={!evidence || busy}
          onChange={(event) =>
            setDecision(event.target.value as "correct" | "remove")
          }
        >
          <option value="correct">Correct</option>
          {evidence?.correction && (
            <option value="remove">Remove correction</option>
          )}
        </Select>
      </div>
      <div>
        <Button
          variant="primary"
          disabled={busy || !evidence || !ready}
          onClick={() => void confirm()}
        >
          Confirm decision
        </Button>
      </div>
      <p role="status" className="m-0 text-meta">
        {status}
      </p>
      {error && (
        <p role="alert" className="m-0 text-meta text-danger">
          {error}
        </p>
      )}
    </ReviewCard>
  );
}
