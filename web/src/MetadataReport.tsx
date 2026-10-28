import { useEffect, useState, type FormEvent } from "react";
import {
  answerMetadataReport,
  getMyMetadataReports,
  submitMetadataReport,
  type MetadataReportInput,
  type MetadataReportView,
} from "./metadata_generated";
import { SelectBox } from "./ui/Select";

export type ReportableEdition = { id: string; label: string };

const reportErrors: Record<string, string> = {
  REPORT_LIMIT:
    "You have too many open metadata reports. Wait for the maintainer to review some.",
  INVALID_PROPOSAL:
    "One of the proposed values is not allowed. Check the formats and try again.",
  EDITION_REQUIRED: "Choose the Edition this report is about.",
  EDITION_PRINTING_MISMATCH: "That Edition does not belong to this Printing.",
  PRINTING_NOT_FOUND: "That Printing no longer exists in the catalog.",
};
const reportError = (error: unknown) =>
  error instanceof Error
    ? (reportErrors[error.message] ??
      "Unable to send the report. Please retry.")
    : "Unable to send the report. Please retry.";

export function proposalSummary(report: Pick<MetadataReportView, "proposed">) {
  const entries = Object.entries(report.proposed).map(
    ([key, value]) => `${key.replace("_", " ")} ${String(value)}`
  );
  return entries.join(", ") || "no proposed value";
}

export function MetadataReport({
  printingId,
  printingName,
  editions,
  initialEditionId,
  onSubmitted,
}: {
  printingId: string;
  printingName: string;
  editions: ReportableEdition[];
  initialEditionId?: string | null;
  onSubmitted?: () => void;
}) {
  const [target, setTarget] = useState<"live" | "marketplace">(
    initialEditionId ? "marketplace" : "live"
  );
  const [issue, setIssue] = useState<"missing" | "incorrect">("incorrect");
  const [editionId, setEditionId] = useState(
    initialEditionId ?? editions[0]?.id ?? ""
  );
  // The picked Edition moved under an open form (#174): the typed text stays and the report follows it.
  const [followed, setFollowed] = useState(initialEditionId ?? null);
  if ((initialEditionId ?? null) !== followed) {
    setFollowed(initialEditionId ?? null);
    if (initialEditionId) setEditionId(initialEditionId);
  }
  const [productId, setProductId] = useState("");
  const [variant, setVariant] = useState("");
  const [category, setCategory] = useState("");
  const [name, setName] = useState("");
  const [setCode, setSetCode] = useState("");
  const [number, setNumber] = useState("");
  const [evidence, setEvidence] = useState("");
  const [note, setNote] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setMessage("");
    setBusy(true);
    const proposed: Record<string, unknown> = {};
    if (target === "marketplace") {
      if (productId.trim()) proposed.product_id = Number(productId);
      if (variant.trim()) proposed.quote_variant = variant.trim();
    } else {
      if (category) proposed.category = category;
      if (name.trim()) proposed.name = name.trim();
      if (setCode.trim()) proposed.set_code = setCode.trim();
      if (number.trim()) proposed.collector_number = number.trim();
    }
    const body: MetadataReportInput = {
      target,
      issue,
      printing_id: printingId,
      edition_id: target === "marketplace" ? editionId : null,
      proposed,
      evidence_url: evidence.trim() || null,
      note: note.trim(),
    };
    try {
      await submitMetadataReport(body);
      setMessage(
        "Submitted for maintainer review; nothing changes until approved."
      );
      setProductId("");
      setVariant("");
      setCategory("");
      setName("");
      setSetCode("");
      setNumber("");
      setEvidence("");
      setNote("");
      onSubmitted?.();
    } catch (error) {
      setMessage(reportError(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Report card metadata" className="metadata-report">
      <h4 className="mb-1">Report card metadata for {printingName}</h4>
      <p className="mb-3 text-text-muted">
        Reports go to the maintainer. They never change a card by themselves.
      </p>
      <form onSubmit={submit}>
        <label>
          What needs fixing{" "}
          <SelectBox
            value={target}
            onChange={(event) =>
              setTarget(event.target.value as "live" | "marketplace")
            }
          >
            <option value="live">Name, set or number</option>
            <option value="marketplace">Price match</option>
          </SelectBox>
        </label>
        <label>
          Issue{" "}
          <SelectBox
            value={issue}
            onChange={(event) =>
              setIssue(event.target.value as "missing" | "incorrect")
            }
          >
            <option value="incorrect">Incorrect</option>
            <option value="missing">Missing</option>
          </SelectBox>
        </label>
        {target === "marketplace" ? (
          <>
            <label>
              Card Edition{" "}
              <SelectBox
                value={editionId}
                onChange={(event) => setEditionId(event.target.value)}
                required
              >
                {editions.map((edition) => (
                  <option key={edition.id} value={edition.id}>
                    {edition.label}
                  </option>
                ))}
              </SelectBox>
            </label>
            <label>
              Correct product number{" "}
              <input
                inputMode="numeric"
                pattern="[0-9]{1,10}"
                value={productId}
                onChange={(event) => setProductId(event.target.value)}
              />
            </label>
            <label>
              Correct price variant{" "}
              <input
                value={variant}
                pattern="[a-z0-9\-]{1,40}"
                maxLength={40}
                onChange={(event) => setVariant(event.target.value)}
              />
            </label>
          </>
        ) : (
          <>
            <label>
              Correct card type{" "}
              <SelectBox
                value={category}
                onChange={(event) => setCategory(event.target.value)}
              >
                <option value="">No change</option>
                <option value="Pokemon">Pokémon</option>
                <option>Trainer</option>
                <option>Energy</option>
              </SelectBox>
            </label>
            <label>
              Correct name{" "}
              <input
                value={name}
                maxLength={160}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label>
              Correct set code{" "}
              <input
                value={setCode}
                pattern="[A-Za-z0-9\-]{1,10}"
                maxLength={10}
                onChange={(event) => setSetCode(event.target.value)}
              />
            </label>
            <label>
              Correct collector number{" "}
              <input
                value={number}
                maxLength={20}
                onChange={(event) => setNumber(event.target.value)}
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
          Note{" "}
          <textarea
            value={note}
            maxLength={2000}
            onChange={(event) => setNote(event.target.value)}
          />
        </label>
        <button type="submit" disabled={busy}>
          Send report
        </button>
      </form>
      <p role="status">{message}</p>
    </section>
  );
}

export function MyMetadataReports({ refreshKey = 0 }: { refreshKey?: number }) {
  const [reports, setReports] = useState<MetadataReportView[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  useEffect(() => {
    void getMyMetadataReports()
      .then((rows) => {
        setReports(rows);
        setMessage("");
      })
      .catch(() => setMessage("Unable to load your metadata reports."));
  }, [refreshKey]);

  async function answer(id: string) {
    try {
      const updated = await answerMetadataReport(id, {
        note: answers[id].trim(),
      });
      setReports((previous) =>
        previous.map((row) => (row.id === id ? updated : row))
      );
      setAnswers((previous) => ({ ...previous, [id]: "" }));
      setMessage("Information sent to the maintainer.");
    } catch {
      setMessage("Unable to send information. Please retry.");
    }
  }

  return (
    <section aria-label="My metadata reports">
      <h3>My metadata reports</h3>
      {reports.length ? (
        <ul>
          {reports.map((report) => (
            <li key={report.id}>
              <strong>
                {report.target === "live"
                  ? "Name, set or number"
                  : "Price match"}{" "}
                · {report.issue}
              </strong>{" "}
              · {report.status.replace("_", " ")}
              <p>Proposed: {proposalSummary(report)}</p>
              {report.review_reason && (
                <p>Maintainer response: {report.review_reason}</p>
              )}
              {report.status === "needs_info" && (
                <div>
                  <label>
                    Additional information{" "}
                    <textarea
                      value={answers[report.id] || ""}
                      onChange={(event) =>
                        setAnswers((previous) => ({
                          ...previous,
                          [report.id]: event.target.value,
                        }))
                      }
                    />
                  </label>
                  <button
                    type="button"
                    disabled={!answers[report.id]?.trim()}
                    onClick={() => void answer(report.id)}
                  >
                    Send information to maintainer
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p>No metadata reports yet.</p>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
