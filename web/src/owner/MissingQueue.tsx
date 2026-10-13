import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import {
  beginOwnerMissingCardReport,
  decideMissingCardReport,
  getOwnerMissingCardReports,
  type ReportView,
} from "../generated";
import { when } from "../MetadataReview";
import { Button } from "../ui/Button";
import { Pill } from "../ui/Pill";
import { Select } from "../ui/Select";
import { TextArea, TextField } from "../ui/TextField";
import { useToast } from "../ui/Toast";
import { CodeStep } from "./CodeStep";
import { CARD_HEADING, FIELDS, ReviewCard, ReviewQueue } from "./ReviewQueue";

type Kind = "printing" | "edition";

const isOpen = (report: ReportView) =>
  report.status === "pending" || report.status === "needs_info";

/** The reported card in a few words, as the collector's Missing cards page names it. */
function label(report: ReportView) {
  return report.kind === "printing"
    ? `${report.english_name || "Unnamed Printing"} · ${report.set_name || report.set_id || "Unknown set"} #${report.collector_number || "?"}`
    : `Edition of Printing ${report.printing_id || "?"}`;
}

function ReviewItem({
  report,
  onClose,
  onDecided,
}: {
  report: ReportView;
  onClose: () => void;
  onDecided: (
    value: "needs_info" | "reject" | "approve",
    updated: ReportView
  ) => void;
}) {
  const reasonField = useRef<HTMLTextAreaElement>(null);
  const [reason, setReason] = useState("");
  const [code, setCode] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [setId, setSetId] = useState(report.set_id || "");
  const [setName, setSetName] = useState(report.set_name || "");
  const [number, setNumber] = useState(report.collector_number || "");
  const [name, setEnglishName] = useState(report.english_name || "");
  const [descriptor, setDescriptor] = useState(
    typeof report.descriptor?.label === "string" ? report.descriptor.label : ""
  );
  const [evidence, setEvidence] = useState(report.evidence_url || "");
  async function decision(value: "needs_info" | "reject" | "approve") {
    setBusy(true);
    setMessage("");
    try {
      const updated = await decideMissingCardReport(report.id, {
        decision: value,
        reason,
        code: value === "approve" ? code : null,
        set_id: setId,
        set_name: setName,
        collector_number: number,
        english_name: name,
        printing_id: report.printing_id,
        descriptor: report.kind === "edition" ? { label: descriptor } : null,
        evidence_url: evidence || null,
      });
      onDecided(value, updated);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Review failed.");
      setBusy(false);
    }
  }
  async function requestCode() {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/auth/approval-code", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          reportId: report.id,
          action: `approve_${report.kind}`,
        }),
      });
      if (!response.ok) {
        const error = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(
          error.error || `Approval-code request failed (${response.status})`
        );
      }
      setMessage("Fresh approval code sent to your email.");
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Unable to send code."
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <ReviewCard
      title={label(report)}
      badge={
        <Pill tone={report.status === "needs_info" ? "warn" : "neutral"}>
          {report.status.replace("_", " ")}
        </Pill>
      }
      onClose={onClose}
      focusRef={reasonField}
    >
      <p className="m-0 text-meta text-text-muted">
        {report.kind === "printing" ? "Missing Printing" : "Missing Edition"} ·
        sent {when(report.created_at)}
      </p>
      {report.note && <p className="m-0">Reporter note: {report.note}</p>}
      {report.evidence_url && (
        <p className="m-0">
          Submitted evidence:{" "}
          <a
            href={report.evidence_url}
            target="_blank"
            rel="noreferrer"
            className="text-accent-strong"
          >
            Open link
          </a>
        </p>
      )}
      <h4 className={CARD_HEADING}>Verified record</h4>
      <div className={FIELDS}>
        {report.kind === "printing" ? (
          <>
            <TextField
              label="Verified set ID"
              value={setId}
              onChange={(event) => setSetId(event.target.value)}
            />
            <TextField
              label="Verified set name"
              value={setName}
              onChange={(event) => setSetName(event.target.value)}
            />
            <TextField
              label="Verified collector number"
              value={number}
              onChange={(event) => setNumber(event.target.value)}
            />
            <TextField
              label="Exact English name"
              value={name}
              onChange={(event) => setEnglishName(event.target.value)}
            />
          </>
        ) : (
          <TextField
            label="Distinct physical Variant Descriptor"
            value={descriptor}
            onChange={(event) => setDescriptor(event.target.value)}
          />
        )}
        <TextField
          label="Evidence link"
          type="url"
          value={evidence}
          onChange={(event) => setEvidence(event.target.value)}
        />
      </div>
      <TextArea
        ref={reasonField}
        label="Review reason"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
      />
      <h4 className={CARD_HEADING}>Decide</h4>
      <p className="m-0 text-meta text-text-muted">
        Request information and Reject need only the reason, which the reporter
        sees. Approving creates the shared record and needs a fresh code.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={busy || !reason.trim()}
          onClick={() => void decision("needs_info")}
        >
          Request information
        </Button>
        <Button
          variant="danger"
          disabled={busy || !reason.trim()}
          onClick={() => void decision("reject")}
        >
          Reject
        </Button>
      </div>
      <CodeStep
        onSend={() => void requestCode()}
        code={code}
        onCode={setCode}
        confirmLabel="Approve shared record"
        ready={!!reason.trim()}
        busy={busy}
        onConfirm={() => void decision("approve")}
      />
      <p role="status" className="m-0 text-meta">
        {message}
      </p>
    </ReviewCard>
  );
}

/** Begin a record directly (folded): the owner starts a shared record without a collector's report. */
function BeginRecord({ onBegun }: { onBegun: (message: string) => void }) {
  const formId = useId();
  const [shown, setShown] = useState(false);
  const [kind, setKind] = useState<Kind>("printing");
  const [setId, setSetId] = useState("");
  const [setName, setSetName] = useState("");
  const [number, setNumber] = useState("");
  const [englishName, setEnglishName] = useState("");
  const [printingId, setPrintingId] = useState("");
  const [descriptor, setDescriptor] = useState("");
  const [evidence, setEvidence] = useState("");
  const [note, setNote] = useState("");
  async function begin(event: FormEvent) {
    event.preventDefault();
    try {
      await beginOwnerMissingCardReport({
        kind,
        set_id: setId || null,
        set_name: setName || null,
        collector_number: number || null,
        english_name: englishName || null,
        printing_id: kind === "edition" ? printingId : null,
        descriptor:
          kind === "edition" && descriptor.trim()
            ? { label: descriptor.trim() }
            : null,
        evidence_url: evidence || null,
        note,
      });
      onBegun("Owner record draft started. Review it below.");
    } catch (error) {
      onBegun(
        error instanceof Error ? error.message : "Unable to begin record."
      );
    }
  }
  return (
    <div className="flex flex-col gap-3">
      <div>
        <Button
          aria-expanded={shown}
          aria-controls={shown ? formId : undefined}
          onClick={() => setShown((value) => !value)}
        >
          Begin a record directly
        </Button>
      </div>
      {shown && (
        <form
          id={formId}
          aria-label="Begin a record directly"
          onSubmit={(event) => void begin(event)}
          className="flex flex-col gap-3 rounded-control border border-border p-3"
        >
          <div className={FIELDS}>
            <Select
              label="Record type"
              value={kind}
              onChange={(event) => setKind(event.target.value as Kind)}
            >
              <option value="printing">Printing</option>
              <option value="edition">Edition</option>
            </Select>
            {kind === "printing" ? (
              <>
                <TextField
                  label="Set ID"
                  value={setId}
                  onChange={(event) => setSetId(event.target.value)}
                />
                <TextField
                  label="Set name"
                  value={setName}
                  onChange={(event) => setSetName(event.target.value)}
                />
                <TextField
                  label="Collector number"
                  value={number}
                  onChange={(event) => setNumber(event.target.value)}
                />
                <TextField
                  label="Exact English name"
                  value={englishName}
                  onChange={(event) => setEnglishName(event.target.value)}
                />
              </>
            ) : (
              <>
                <TextField
                  label="Printing ID"
                  value={printingId}
                  onChange={(event) => setPrintingId(event.target.value)}
                  required
                />
                <TextField
                  label="Physical Variant Descriptor"
                  value={descriptor}
                  onChange={(event) => setDescriptor(event.target.value)}
                />
              </>
            )}
            <TextField
              label="Evidence link"
              type="url"
              value={evidence}
              onChange={(event) => setEvidence(event.target.value)}
            />
          </div>
          <TextArea
            label="Note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
          <div>
            <Button type="submit" variant="primary">
              Begin record
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

/**
 * Owner controls' Missing cards queue (#168): open missing-card reports as a ScrollTable, with Begin a
 * record directly folded above it. A report's card shows the report, its note and evidence, and the
 * verified fields. Request information and Reject need only the reason; Approve shared record takes a
 * fresh code. Approving or rejecting removes the row; asking for information keeps it, now "needs info".
 * Each shows a toast.
 */
export function MissingQueue({ onChanged }: { onChanged: () => void }) {
  const [reports, setReports] = useState<ReportView[]>([]);
  const [message, setMessage] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const toast = useToast();
  async function refresh() {
    try {
      const next = (await getOwnerMissingCardReports()).filter(isOpen);
      setReports(next);
      setOpen((current) =>
        current && next.some((report) => report.id === current) ? current : null
      );
      setMessage("");
    } catch {
      setMessage("Unable to load review queue.");
    }
  }
  useEffect(() => {
    void refresh();
  }, []);
  function decided(
    report: ReportView,
    value: "needs_info" | "reject" | "approve",
    updated: ReportView,
    close: () => void
  ) {
    if (value === "needs_info") {
      setReports((previous) =>
        previous.map((row) => (row.id === report.id ? updated : row))
      );
      close();
      toast.show({
        message: `Information requested from the reporter: ${label(report)}.`,
      });
    } else {
      setReports((previous) => previous.filter((row) => row.id !== report.id));
      setOpen(null);
      toast.show({
        message:
          value === "approve"
            ? `Approved shared record: ${label(report)}.`
            : `Report rejected: ${label(report)}.`,
      });
    }
    onChanged();
  }
  return (
    <ReviewQueue
      title="Missing-card review queue"
      intro="Collectors' private reports of Printings and Editions the catalog lacks. Approving one creates a shared record."
      tableLabel="Open reports"
      rows={reports.map((report) => ({
        key: report.id,
        label: label(report),
        card:
          report.kind === "printing"
            ? report.english_name || "Unnamed Printing"
            : label(report),
        setNumber:
          report.kind === "printing"
            ? `${report.set_name || report.set_id || "Unknown set"} #${report.collector_number || "?"}`
            : "—",
        kind: (
          <>
            {report.kind === "printing"
              ? "Missing Printing"
              : "Missing Edition"}
            {report.status === "needs_info" && (
              <>
                {" "}
                <Pill tone="warn">needs info</Pill>
              </>
            )}
          </>
        ),
        reports: "1",
        opened: report.created_at,
      }))}
      emptyText="No reports."
      open={open}
      onOpen={setOpen}
      renderCard={(key, close) => {
        const report = reports.find((row) => row.id === key);
        return (
          report && (
            <ReviewItem
              key={key}
              report={report}
              onClose={close}
              onDecided={(value, updated) =>
                decided(report, value, updated, close)
              }
            />
          )
        );
      }}
      onRefresh={() => void refresh()}
      status={message}
      before={
        <BeginRecord
          onBegun={(text) => void refresh().then(() => setMessage(text))}
        />
      }
    />
  );
}
