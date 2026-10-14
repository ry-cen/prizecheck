import { useEffect, useId, useRef, useState } from "react";
import {
  decideMetadata,
  decideMetadataReport,
  getMetadataHistory,
  getMetadataQueue,
  getMetadataTarget,
  requestMetadataCode,
  type MetadataDecisionInput,
  type MetadataDecisionRow,
  type MetadataQueueItem,
} from "./metadata_generated";
import { CodeStep } from "./owner/CodeStep";
import {
  CARD_HEADING,
  Differs,
  FIELDS,
  ReviewCard,
  ReviewQueue,
  type QueueRow,
} from "./owner/ReviewQueue";
import { Button } from "./ui/Button";
import { Pill } from "./ui/Pill";
import { ScrollTable } from "./ui/ScrollTable";
import { Select } from "./ui/Select";
import { TextArea, TextField } from "./ui/TextField";
import { useToast } from "./ui/Toast";

const messages: Record<string, string> = {
  METADATA_EVIDENCE_CHANGED:
    "Evidence changed since you opened this target. Reload evidence and review it again before deciding.",
  INVALID_APPROVAL_CODE:
    "That code is invalid, used or expired. Send a new code.",
  FRESH_CODE_REQUIRED: "Enter the fresh six-digit code first.",
  CATALOG_BUSY:
    "The catalog is busy with another change. Try again in a moment.",
  MAPPING_CONFLICT:
    "Another verified Edition already uses that product and variant.",
  INVALID_PRODUCT:
    "Enter a valid product ID (1 to 2147483647) and a lowercase quote variant, or leave the variant empty.",
  UNSPECIFIED_VARIANT:
    "An Unspecified Variant can never be verified. Leave it unmapped.",
  INVALID_DECISION: "That decision is not allowed for this target.",
  NO_ACTIVE_RULE:
    "No Live rule is active. Activate a rule before verifying or correcting Live identity.",
  INVALID_LIVE_INPUT:
    "The Live inputs are incomplete or not covered by the active rule.",
  LIVE_CONFLICT: "Those Live inputs conflict with another Printing.",
  INVALID_REPORT:
    "A linked report is no longer open for this target. Reload evidence.",
  TARGET_NOT_FOUND: "That target no longer exists.",
  REASON_REQUIRED: "A reason is required.",
  EDITION_PRINTING_MISMATCH: "That Edition does not belong to the Printing.",
  ALREADY_REVIEWED: "That report has already been reviewed.",
  UNKNOWN_RULE_VERSION: "That rule version does not exist.",
  REPORT_NOT_FOUND: "That report no longer exists.",
};
export const errorText = (error: unknown) =>
  error instanceof Error
    ? (messages[error.message] ?? "The request failed. Please retry.")
    : "The request failed. Please retry.";
export const codeError = (error: unknown) =>
  (error as { status?: number })?.status === 429
    ? "Code rate limit reached. Try again in a minute."
    : "Unable to send the code. Please retry.";

function safeLink(value: string | null): string | undefined {
  // Reporter-supplied: only http(s) is ever a link.
  return value && /^https?:\/\//i.test(value) ? value : undefined;
}

function summarize(value: Record<string, unknown> | null | undefined) {
  if (!value || !Object.keys(value).length) return "none";
  return Object.entries(value)
    .map(
      ([key, entry]) =>
        `${key.replace(/_/g, " ")} ${entry === null ? "none" : typeof entry === "object" ? JSON.stringify(entry) : String(entry)}`
    )
    .join(", ");
}
function editionLabel(descriptor: Record<string, unknown> | null) {
  if (!descriptor) return "Edition";
  if (typeof descriptor.label === "string") return descriptor.label;
  return Object.entries(descriptor)
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join(" · ");
}
export const when = (value: string) => new Date(value).toLocaleString();

type Decision = MetadataDecisionInput["decision"];
const decisionOptions: Record<
  MetadataQueueItem["target"],
  [Decision, string][]
> = {
  marketplace: [
    ["verify_source", "Accept source mapping"],
    ["correct", "Correct mapping"],
    ["reject_source", "Reject source value"],
    ["unmap", "Leave unmapped"],
  ],
  live: [
    ["verify_source", "Accept source identity"],
    ["correct", "Correct identity"],
    ["reject_source", "Reject source value"],
    ["unsupported", "Mark unsupported"],
  ],
};

function History({
  item,
  refreshKey,
}: {
  item: MetadataQueueItem;
  refreshKey: number;
}) {
  const [rows, setRows] = useState<MetadataDecisionRow[] | null>(null);
  const [message, setMessage] = useState("");
  const kind = item.kind === "edition" ? "editions" : "printings";
  useEffect(() => {
    setMessage("");
    void getMetadataHistory(kind, item.edition_id ?? item.printing_id)
      .then(setRows)
      .catch(() => setMessage("Unable to load the decision history."));
  }, [item.edition_id, item.printing_id, kind, refreshKey]);
  return (
    <section
      aria-label="Decision history"
      className="flex flex-col gap-2 border-t border-border pt-3"
    >
      <h4 className={CARD_HEADING}>Decision history</h4>
      {message && (
        <p role="alert" className="m-0 text-meta text-danger">
          {message}
        </p>
      )}
      {rows &&
        (rows.length ? (
          <ol className="m-0 flex flex-col gap-3 pl-5 text-meta">
            {rows.map((row) => (
              <li key={row.id} className="flex flex-col gap-0.5">
                <span>
                  <strong>{row.decision.replace(/_/g, " ")}</strong> ·{" "}
                  {when(row.reviewed_at)} · reviewer {row.reviewer_id} · public
                  revision {row.clock_revision}
                </span>
                <span>Reviewed value: {summarize(row.reviewed_value)}</span>
                {row.source_value && (
                  <span>
                    Source value at decision: {summarize(row.source_value)}
                  </span>
                )}
                <span>Checks: {summarize(row.checks)}</span>
                <span>Reason: {row.reason}</span>
                <span>
                  {row.rule_kind
                    ? `Rule: ${row.rule_kind} v${row.rule_version}`
                    : "No rule"}
                </span>
                <p className="m-0">
                  Evidence:{" "}
                  <a
                    href={row.evidence_url}
                    target="_blank"
                    rel="noreferrer"
                    className="break-all text-accent-strong underline"
                  >
                    {row.evidence_url}
                  </a>
                </p>
              </li>
            ))}
          </ol>
        ) : (
          <p className="m-0 text-meta text-text-muted">
            No maintainer decisions yet.
          </p>
        ))}
    </section>
  );
}

/** One value of a compared field, as summarize writes it. */
function valueText(value: unknown) {
  if (value === undefined || value === null) return "none";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

/** Source and reviewed values side by side, a field per row, each difference marked in words. */
function Compare({ item }: { item: MetadataQueueItem }) {
  const source = item.source_fingerprint ? item.source_candidate : {};
  const reviewed = item.reviewed_value ?? {};
  const fields = [
    ...new Set([...Object.keys(source), ...Object.keys(reviewed)]),
  ];
  if (!fields.length)
    return (
      <p className="m-0 text-meta text-text-muted">
        Source value: none · Reviewed value: none
      </p>
    );
  return (
    <ScrollTable label="Source and reviewed values">
      <thead>
        <tr>
          <th scope="col">Field</th>
          <th scope="col">Source value</th>
          <th scope="col">Reviewed value</th>
        </tr>
      </thead>
      <tbody>
        {fields.map((field) => {
          const differs =
            item.reviewed_value !== null &&
            valueText(source[field]) !== valueText(reviewed[field]);
          return (
            <tr key={field}>
              <td>
                {field.replace(/_/g, " ")} {differs && <Differs />}
              </td>
              <td className="max-w-96 whitespace-normal break-words">
                {valueText(source[field])}
              </td>
              <td className="max-w-96 whitespace-normal break-words">
                {valueText(reviewed[field])}
              </td>
            </tr>
          );
        })}
      </tbody>
    </ScrollTable>
  );
}

function label(item: MetadataQueueItem) {
  return `${item.name ?? "Unnamed Printing"} · ${item.target === "marketplace" ? editionLabel(item.descriptor) : "Live identity"}`;
}

function ReviewItem({
  item,
  onItem,
  onClose,
  onDecided,
  onChanged,
}: {
  item: MetadataQueueItem;
  onItem: (next: MetadataQueueItem) => void;
  onClose: () => void;
  /** A confirmed decision: the queue removes the row and shows `message` in a toast. */
  onDecided: (message: string) => void;
  /** Something changed that the tab counts show. */
  onChanged: () => void;
}) {
  const toast = useToast();
  const hasReports = item.report_ids.length > 0;
  const closeId = useId();
  const reasonField = useRef<HTMLTextAreaElement>(null);
  const [decision, setDecision] = useState<Decision>(
    hasReports ? "correct" : "verify_source"
  );
  const [productId, setProductId] = useState("");
  const [variant, setVariant] = useState("");
  const [category, setCategory] = useState("Pokemon");
  const [name, setName] = useState("");
  const [liveSetCode, setLiveSetCode] = useState("");
  const [number, setNumber] = useState("");
  const [evidence, setEvidence] = useState("");
  const [reason, setReason] = useState("");
  const [closeReports, setCloseReports] = useState(true);
  const [code, setCode] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState(false);
  const [historyKey, setHistoryKey] = useState(0);
  const kind = item.kind === "edition" ? "editions" : "printings";
  const targetId = item.edition_id ?? item.printing_id;

  function reviewedValue(): Record<string, unknown> | null {
    if (decision !== "correct") return null;
    if (item.target === "marketplace")
      return {
        product_id: Number(productId),
        quote_variant: variant.trim() || null,
      };
    return {
      category,
      name: name.trim(),
      set_code: liveSetCode.trim().toUpperCase(),
      collector_number: number.trim(),
    };
  }
  // Everything the decision needs except the code, which the code step checks.
  const ready =
    !!reason.trim() &&
    !!evidence.trim() &&
    (decision !== "correct" ||
      (item.target === "marketplace"
        ? /^[0-9]+$/.test(productId)
        : !!(name.trim() && liveSetCode.trim() && number.trim())));

  async function reload(message?: string) {
    const next = await getMetadataTarget(kind, targetId);
    onItem(next);
    setHistoryKey((value) => value + 1);
    if (message !== undefined) setStatus(message);
  }

  async function sendCode() {
    setBusy(true);
    setError("");
    try {
      await requestMetadataCode(`${item.kind}:${targetId}`, "resolve_metadata");
      setStatus("Fresh approval code sent to your email.");
    } catch (failure) {
      setStatus("");
      setError(codeError(failure));
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    setBusy(true);
    setError("");
    setStale(false);
    try {
      const result = await decideMetadata({
        target: item.target,
        printing_id: item.printing_id,
        edition_id: item.edition_id,
        decision,
        reviewed_value: reviewedValue(),
        basis_revision: item.basis_revision,
        evidence_digest: item.evidence_digest,
        evidence_url: evidence.trim(),
        reason: reason.trim(),
        report_ids: closeReports ? item.report_ids : [],
        code,
      });
      const text = `Decision recorded: ${result.state.replace(/_/g, " ")}${result.reason ? ` (${result.reason})` : ""}. Public delivery: ${result.public_delivery}.`;
      // A target stays queued while any report is still open (the box was unticked, or more than 25
      // were linked), so only a target with none left leaves the list.
      const next = await getMetadataTarget(kind, targetId).catch(() => null);
      if (next && next.report_ids.length > 0) {
        onItem(next);
        onClose();
        toast.show({ message: `${label(item)}: ${text}` });
        onChanged();
      } else {
        onDecided(text);
      }
    } catch (failure) {
      setStatus("");
      setStale(
        failure instanceof Error &&
          failure.message === "METADATA_EVIDENCE_CHANGED"
      );
      setError(errorText(failure));
      setBusy(false);
    }
  }

  async function reloadEvidence() {
    setBusy(true);
    try {
      await reload("");
      setError("");
      setStale(false);
    } catch {
      setError("Unable to reload the evidence. Please retry.");
    } finally {
      setBusy(false);
    }
  }

  async function reportDecision(
    reportId: string,
    value: "needs_info" | "reject"
  ) {
    setBusy(true);
    setError("");
    try {
      await decideMetadataReport(reportId, {
        decision: value,
        reason: reason.trim(),
      });
      await reload(
        value === "reject"
          ? "Report rejected."
          : "Information requested from the reporter."
      );
      onChanged();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ReviewCard
      title={label(item)}
      badge={
        <Pill tone={item.state === "verified" ? "ok" : "warn"}>
          {item.state.replace(/_/g, " ")}
        </Pill>
      }
      onClose={onClose}
      focusRef={reasonField}
    >
      <p className="m-0 text-meta text-text-muted">
        State: {item.state.replace(/_/g, " ")}
        {item.reason ? ` · Reason: ${item.reason}` : ""} · Revision{" "}
        {item.basis_revision}
        {item.set_id ? ` · ${item.set_id} #${item.collector_number}` : ""}
      </p>
      <Compare item={item} />
      <p className="m-0 text-meta">
        {item.report_ids.length} linked report
        {item.report_ids.length === 1 ? "" : "s"}
        {item.rejected_fingerprints.length > 0 &&
          ` · ${item.rejected_fingerprints.length} previously rejected source value${item.rejected_fingerprints.length === 1 ? "" : "s"}`}
      </p>
      {hasReports && (
        <>
          <p className="m-0 text-meta text-text-muted">
            Ask for information and Reject report send the review reason below
            to the reporter.
          </p>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {item.reports.map((report) => {
              const id = report.id;
              return (
                <li
                  key={id}
                  className="flex flex-col gap-1 rounded-control border border-border p-3 text-meta"
                >
                  <span className="font-semibold">
                    Report {id.slice(0, 8)} ({report.issue},{" "}
                    {report.status.replace(/_/g, " ")})
                  </span>
                  <span>Proposed: {summarize(report.proposed)}</span>
                  {report.note && <span>Note: {report.note}</span>}
                  {safeLink(report.evidence_url) && (
                    <p className="m-0">
                      Evidence:{" "}
                      <a
                        href={safeLink(report.evidence_url)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="break-all text-accent-strong underline"
                      >
                        {report.evidence_url}
                      </a>
                    </p>
                  )}
                  <span className="flex flex-wrap gap-2">
                    <Button
                      disabled={busy || !reason.trim()}
                      aria-label={`Ask reporter for information on report ${id.slice(0, 8)}`}
                      onClick={() => void reportDecision(id, "needs_info")}
                    >
                      Ask for information
                    </Button>
                    <Button
                      variant="danger"
                      disabled={busy || !reason.trim()}
                      aria-label={`Reject report ${id.slice(0, 8)}`}
                      onClick={() => void reportDecision(id, "reject")}
                    >
                      Reject report
                    </Button>
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      )}
      <div className={FIELDS}>
        <TextArea
          ref={reasonField}
          label="Review reason"
          value={reason}
          maxLength={2000}
          onChange={(event) => setReason(event.target.value)}
        />
        <TextField
          label="Review evidence URL"
          type="url"
          value={evidence}
          onChange={(event) => setEvidence(event.target.value)}
        />
      </div>
      <h4 className={CARD_HEADING}>Decide</h4>
      <div className={FIELDS}>
        <Select
          label="Decision"
          value={decision}
          onChange={(event) => setDecision(event.target.value as Decision)}
        >
          {decisionOptions[item.target].map(([value, text]) => (
            <option key={value} value={value}>
              {text}
            </option>
          ))}
        </Select>
        {decision === "correct" &&
          (item.target === "marketplace" ? (
            <>
              <TextField
                label="Product ID"
                inputMode="numeric"
                value={productId}
                onChange={(event) => setProductId(event.target.value)}
              />
              <TextField
                label="Quote variant"
                value={variant}
                maxLength={40}
                onChange={(event) => setVariant(event.target.value)}
              />
            </>
          ) : (
            <>
              <Select
                label="Category"
                value={category}
                onChange={(event) => setCategory(event.target.value)}
              >
                <option>Pokemon</option>
                <option>Trainer</option>
                <option>Energy</option>
              </Select>
              <TextField
                label="Live name"
                value={name}
                maxLength={160}
                onChange={(event) => setName(event.target.value)}
              />
              <TextField
                label="Live set code"
                value={liveSetCode}
                maxLength={10}
                onChange={(event) => setLiveSetCode(event.target.value)}
              />
              <TextField
                label="Live collector number"
                value={number}
                maxLength={20}
                onChange={(event) => setNumber(event.target.value)}
              />
            </>
          ))}
      </div>
      {hasReports && (
        <label
          htmlFor={closeId}
          className="flex items-center gap-2 text-meta phone:min-h-tap"
        >
          <input
            id={closeId}
            type="checkbox"
            className="m-0 size-4 accent-accent"
            checked={closeReports}
            onChange={(event) => setCloseReports(event.target.checked)}
          />
          Close linked reports with this decision
        </label>
      )}
      <CodeStep
        onSend={() => void sendCode()}
        code={code}
        onCode={setCode}
        confirmLabel="Confirm decision"
        ready={ready}
        busy={busy}
        onConfirm={() => void submit()}
      />
      <p role="status" className="m-0 text-meta">
        {status}
      </p>
      {error && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 text-meta text-danger"
        >
          <p className="m-0">{error}</p>
          {stale && (
            <Button disabled={busy} onClick={() => void reloadEvidence()}>
              Reload evidence
            </Button>
          )}
        </div>
      )}
      <div>
        <Button
          variant="quiet"
          onClick={() => setHistory((value) => !value)}
          aria-expanded={history}
        >
          {history ? "Hide history" : "Show history"}
        </Button>
      </div>
      {history && <History item={item} refreshKey={historyKey} />}
    </ReviewCard>
  );
}

const key = (item: MetadataQueueItem) =>
  `${item.kind}:${item.edition_id ?? item.printing_id}`;

function row(item: MetadataQueueItem): QueueRow {
  // The queue doesn't record when a target was quarantined or suspended, so a target opens with its oldest
  // open report, and one without reports shows no date.
  const opened =
    item.reports
      .map((report) => report.created_at)
      .sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null;
  return {
    key: key(item),
    label: label(item),
    card: item.name ?? "Unnamed Printing",
    setNumber: item.set_id ? `${item.set_id} #${item.collector_number}` : "—",
    kind: (
      <>
        {item.target === "marketplace"
          ? `Marketplace · ${editionLabel(item.descriptor)}`
          : "Live identity"}{" "}
        <Pill tone={item.state === "verified" ? "ok" : "warn"}>
          {item.state.replace(/_/g, " ")}
        </Pill>
      </>
    ),
    reports: String(item.report_ids.length),
    opened,
  };
}

/**
 * Owner controls' Metadata queue (#168): quarantined Editions, suspended Printings and collector reports
 * as a ScrollTable, 100 at a time with Load more. A target's card shows source and reviewed values side by
 * side with differences marked, its linked reports with Ask for information and Reject report, the
 * decision with a reason, a review evidence URL and a fresh code, and the decision history folded away. A
 * confirmed decision removes the row and shows a toast; a report decision reloads the target in place.
 */
export function MetadataReview({ onChanged }: { onChanged: () => void }) {
  const [items, setItems] = useState<MetadataQueueItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const toast = useToast();

  async function load(next?: string) {
    try {
      const page = await getMetadataQueue(next);
      setItems((previous) =>
        next ? [...previous, ...page.items] : page.items
      );
      if (!next)
        setOpen((current) =>
          current && page.items.some((item) => key(item) === current)
            ? current
            : null
        );
      setCursor(page.next_cursor);
      setMessage("");
    } catch {
      setMessage("Unable to load the metadata review queue.");
    }
  }
  useEffect(() => {
    void load();
  }, []);

  function decided(item: MetadataQueueItem, text: string) {
    setItems((previous) => previous.filter((row) => key(row) !== key(item)));
    setOpen(null);
    toast.show({ message: `${label(item)}: ${text}` });
    onChanged();
  }

  return (
    <ReviewQueue
      title="Catalog metadata review"
      intro="Quarantined Editions, suspended Printings and collector reports. Nothing changes until you record a decision with a fresh code."
      tableLabel="Metadata targets"
      rows={items.map(row)}
      emptyText="No metadata targets need review."
      open={open}
      onOpen={setOpen}
      renderCard={(rowKey, close) => {
        const item = items.find((entry) => key(entry) === rowKey);
        return (
          item && (
            <ReviewItem
              key={rowKey}
              item={item}
              onClose={close}
              onItem={(next) =>
                setItems((previous) =>
                  previous.map((entry) =>
                    key(entry) === key(next) ? next : entry
                  )
                )
              }
              onDecided={(text) => decided(item, text)}
              onChanged={onChanged}
            />
          )
        );
      }}
      onRefresh={() => void load()}
      status={message}
      after={
        cursor && (
          <div>
            <Button onClick={() => void load(cursor)}>Load more</Button>
          </div>
        )
      }
    />
  );
}
