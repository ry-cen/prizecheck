import { useEffect, useState, type FormEvent } from "react";
import {
  getMyMissingCardReports,
  respondToMissingCardReview,
  submitMissingCardReport,
  type ReportView,
} from "./generated";

type Kind = "printing" | "edition";

function label(report: ReportView) {
  return report.kind === "printing"
    ? `${report.english_name || "Unnamed Printing"} · ${report.set_name || report.set_id || "Unknown set"} #${report.collector_number || "?"}`
    : `Edition of Printing ${report.printing_id || "?"}`;
}

export function MissingCardReports({ printingId }: { printingId?: string }) {
  const [reports, setReports] = useState<ReportView[]>([]);
  const [kind, setKind] = useState<Kind>(printingId ? "edition" : "printing");
  const [setId, setSetId] = useState("");
  const [setName, setSetName] = useState("");
  const [number, setNumber] = useState("");
  const [name, setEnglishName] = useState("");
  const [target, setTarget] = useState(printingId || "");
  const [descriptor, setDescriptor] = useState("");
  const [evidence, setEvidence] = useState("");
  const [note, setNote] = useState("");
  const [message, setMessage] = useState("");
  const [responses, setResponses] = useState<Record<string, string>>({});
  useEffect(() => {
    void getMyMissingCardReports()
      .then(setReports)
      .catch(() => setMessage("Unable to load your reports."));
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setMessage("");
    try {
      const row = await submitMissingCardReport({
        kind,
        set_id: kind === "printing" ? setId : null,
        set_name: kind === "printing" ? setName : null,
        collector_number: kind === "printing" ? number : null,
        english_name: kind === "printing" ? name : null,
        printing_id: kind === "edition" ? target : null,
        descriptor:
          kind === "edition" && descriptor.trim()
            ? { label: descriptor.trim() }
            : null,
        evidence_url: evidence || null,
        note,
      });
      setReports((previous) => [row, ...previous]);
      setMessage("Report sent privately to the owner.");
      setEvidence("");
      setNote("");
      setDescriptor("");
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Unable to submit report."
      );
    }
  }
  async function respond(id: string) {
    try {
      const updated = await respondToMissingCardReview(id, {
        note: responses[id],
      });
      setReports((previous) =>
        previous.map((row) => (row.id === id ? updated : row))
      );
      setMessage("Information sent to the owner.");
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Unable to send information."
      );
    }
  }
  return (
    <section aria-label="Missing-card reports">
      <h2>Report a missing English card</h2>
      <p>
        Reports are private to you and the owner. They do not add a catalog
        record.
      </p>
      <form onSubmit={submit}>
        <label>
          Report type{" "}
          <select
            value={kind}
            onChange={(event) => setKind(event.target.value as Kind)}
          >
            <option value="printing">Missing Printing</option>
            <option value="edition">Missing Edition</option>
          </select>
        </label>
        {kind === "printing" ? (
          <>
            <label>
              Set ID{" "}
              <input
                value={setId}
                onChange={(event) => setSetId(event.target.value)}
                maxLength={80}
              />
            </label>
            <label>
              Set name{" "}
              <input
                value={setName}
                onChange={(event) => setSetName(event.target.value)}
                maxLength={160}
              />
            </label>
            <label>
              Collector number{" "}
              <input
                value={number}
                onChange={(event) => setNumber(event.target.value)}
                maxLength={80}
              />
            </label>
            <label>
              English name{" "}
              <input
                value={name}
                onChange={(event) => setEnglishName(event.target.value)}
                maxLength={160}
              />
            </label>
          </>
        ) : (
          <>
            <label>
              Printing ID{" "}
              <input
                value={target}
                onChange={(event) => setTarget(event.target.value)}
                required
              />
            </label>
            <label>
              Physical variant details{" "}
              <input
                value={descriptor}
                onChange={(event) => setDescriptor(event.target.value)}
                placeholder="Finish, foil pattern, stamp, size…"
              />
            </label>
          </>
        )}
        <label>
          Evidence link{" "}
          <input
            type="url"
            value={evidence}
            onChange={(event) => setEvidence(event.target.value)}
          />
        </label>
        <label>
          What is missing?{" "}
          <textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            maxLength={2000}
          />
        </label>
        <button type="submit">Send private report</button>
      </form>
      <p role="status">{message}</p>
      <h3>Your reports</h3>
      {reports.length ? (
        <ul>
          {reports.map((report) => (
            <li key={report.id}>
              <strong>{label(report)}</strong> ·{" "}
              {report.status.replace("_", " ")}
              {report.review_reason && (
                <p>Owner response: {report.review_reason}</p>
              )}
              {report.status === "needs_info" && (
                <div>
                  <label>
                    Additional information{" "}
                    <textarea
                      value={responses[report.id] || ""}
                      onChange={(event) =>
                        setResponses((previous) => ({
                          ...previous,
                          [report.id]: event.target.value,
                        }))
                      }
                    />
                  </label>
                  <button
                    type="button"
                    disabled={!responses[report.id]?.trim()}
                    onClick={() => void respond(report.id)}
                  >
                    Send information
                  </button>
                </div>
              )}
              {report.approved_printing_id && (
                <p>Approved Printing: {report.approved_printing_id}</p>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p>No reports yet.</p>
      )}
    </section>
  );
}
