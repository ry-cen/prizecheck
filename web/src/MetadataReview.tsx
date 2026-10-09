import { useEffect, useId, useState } from "react";
import {
  activateMetadataRule,
  decideMetadata,
  decideMetadataReport,
  getMetadataHistory,
  getMetadataQueue,
  getMetadataRules,
  getMetadataTarget,
  requestMetadataCode,
  type MetadataDecisionInput,
  type MetadataDecisionRow,
  type MetadataQueueItem,
  type MetadataRuleView,
} from "./metadata_generated";

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
const errorText = (error: unknown) =>
  error instanceof Error
    ? (messages[error.message] ?? "The request failed. Please retry.")
    : "The request failed. Please retry.";
const codeError = (error: unknown) =>
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
const when = (value: string) => new Date(value).toLocaleString();
const looksLikeCode = (value: string) => /^[0-9]{6}$/.test(value);

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
    <section aria-label="Decision history">
      <h5>Decision history</h5>
      {message && <p role="alert">{message}</p>}
      {rows &&
        (rows.length ? (
          <ol>
            {rows.map((row) => (
              <li key={row.id}>
                <strong>{row.decision.replace(/_/g, " ")}</strong> ·{" "}
                {when(row.reviewed_at)} · reviewer {row.reviewer_id} · public
                revision {row.clock_revision}
                <p>Reviewed value: {summarize(row.reviewed_value)}</p>
                {row.source_value && (
                  <p>Source value at decision: {summarize(row.source_value)}</p>
                )}
                <p>Checks: {summarize(row.checks)}</p>
                <p>Reason: {row.reason}</p>
                <p>
                  {row.rule_kind
                    ? `Rule: ${row.rule_kind} v${row.rule_version}`
                    : "No rule"}
                </p>
                <p>
                  Evidence:{" "}
                  <a href={row.evidence_url} target="_blank" rel="noreferrer">
                    {row.evidence_url}
                  </a>
                </p>
              </li>
            ))}
          </ol>
        ) : (
          <p>No maintainer decisions yet.</p>
        ))}
    </section>
  );
}

function ReviewItem({
  item,
  onItem,
}: {
  item: MetadataQueueItem;
  onItem: (next: MetadataQueueItem) => void;
}) {
  const hasReports = item.report_ids.length > 0;
  const decisionId = useId();
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
  const heading = `${item.name ?? "Unnamed Printing"} · ${item.target === "marketplace" ? editionLabel(item.descriptor) : "Live identity"}`;
  const label =
    item.target === "marketplace"
      ? `${item.name ?? "Printing"} ${editionLabel(item.descriptor)}`
      : `${item.name ?? "Printing"} Live identity`;

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
  const complete =
    !!reason.trim() &&
    !!evidence.trim() &&
    looksLikeCode(code) &&
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
      setCode("");
      await reload(
        `Decision recorded: ${result.state.replace(/_/g, " ")}${result.reason ? ` (${result.reason})` : ""}. Public delivery: ${result.public_delivery}.`
      );
    } catch (failure) {
      setStatus("");
      setStale(
        failure instanceof Error &&
          failure.message === "METADATA_EVIDENCE_CHANGED"
      );
      setError(errorText(failure));
    } finally {
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
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <article aria-label={`Metadata review: ${label}`}>
      <h4>{heading}</h4>
      <p>
        State: {item.state.replace(/_/g, " ")}
        {item.reason ? ` · Reason: ${item.reason}` : ""} · Revision{" "}
        {item.basis_revision}
      </p>
      {item.set_id && (
        <p>
          {item.set_id} #{item.collector_number}
        </p>
      )}
      <p>
        Source value:{" "}
        {item.source_fingerprint ? summarize(item.source_candidate) : "none"}
      </p>
      <p>Reviewed value: {summarize(item.reviewed_value)}</p>
      <p>
        {item.report_ids.length} linked report
        {item.report_ids.length === 1 ? "" : "s"}
      </p>
      {item.rejected_fingerprints.length > 0 && (
        <p>
          {item.rejected_fingerprints.length} previously rejected source value
          {item.rejected_fingerprints.length === 1 ? "" : "s"}
        </p>
      )}
      {hasReports && (
        <ul>
          {item.reports.map((report) => {
            const id = report.id;
            return (
              <li key={id}>
                Report {id.slice(0, 8)} ({report.issue},{" "}
                {report.status.replace(/_/g, " ")})
                <div>Proposed: {summarize(report.proposed)}</div>
                {report.note && <div>Note: {report.note}</div>}
                {safeLink(report.evidence_url) && (
                  <div>
                    Evidence:{" "}
                    <a
                      href={safeLink(report.evidence_url)}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {report.evidence_url}
                    </a>
                  </div>
                )}{" "}
                <button
                  type="button"
                  disabled={busy || !reason.trim()}
                  aria-label={`Ask reporter for information on report ${id.slice(0, 8)}`}
                  onClick={() => void reportDecision(id, "needs_info")}
                >
                  Ask for information
                </button>{" "}
                <button
                  type="button"
                  disabled={busy || !reason.trim()}
                  aria-label={`Reject report ${id.slice(0, 8)}`}
                  onClick={() => void reportDecision(id, "reject")}
                >
                  Reject report
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <label htmlFor={decisionId}>Decision</label>
      <select
        id={decisionId}
        value={decision}
        onChange={(event) => setDecision(event.target.value as Decision)}
      >
        {decisionOptions[item.target].map(([value, text]) => (
          <option key={value} value={value}>
            {text}
          </option>
        ))}
      </select>
      {decision === "correct" &&
        (item.target === "marketplace" ? (
          <>
            <label>
              Product ID{" "}
              <input
                inputMode="numeric"
                value={productId}
                onChange={(event) => setProductId(event.target.value)}
              />
            </label>
            <label>
              Quote variant{" "}
              <input
                value={variant}
                maxLength={40}
                onChange={(event) => setVariant(event.target.value)}
              />
            </label>
          </>
        ) : (
          <>
            <label>
              Category{" "}
              <select
                value={category}
                onChange={(event) => setCategory(event.target.value)}
              >
                <option>Pokemon</option>
                <option>Trainer</option>
                <option>Energy</option>
              </select>
            </label>
            <label>
              Live name{" "}
              <input
                value={name}
                maxLength={160}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label>
              Live set code{" "}
              <input
                value={liveSetCode}
                maxLength={10}
                onChange={(event) => setLiveSetCode(event.target.value)}
              />
            </label>
            <label>
              Live collector number{" "}
              <input
                value={number}
                maxLength={20}
                onChange={(event) => setNumber(event.target.value)}
              />
            </label>
          </>
        ))}
      <label>
        Decision evidence URL{" "}
        <input
          type="url"
          value={evidence}
          onChange={(event) => setEvidence(event.target.value)}
        />
      </label>
      <label>
        Decision reason{" "}
        <textarea
          value={reason}
          maxLength={2000}
          onChange={(event) => setReason(event.target.value)}
        />
      </label>
      {hasReports && (
        <label>
          <span>
            <input
              type="checkbox"
              checked={closeReports}
              onChange={(event) => setCloseReports(event.target.checked)}
            />{" "}
            Close linked reports with this decision
          </span>
        </label>
      )}
      <button type="button" disabled={busy} onClick={() => void sendCode()}>
        Send code
      </button>
      <label>
        Fresh six-digit code{" "}
        <input
          inputMode="numeric"
          pattern="[0-9]{6}"
          maxLength={6}
          value={code}
          onChange={(event) => setCode(event.target.value)}
        />
      </label>
      <button
        type="button"
        disabled={busy || !complete}
        onClick={() => void submit()}
      >
        Record decision
      </button>{" "}
      <button
        type="button"
        onClick={() => setHistory((value) => !value)}
        aria-expanded={history}
      >
        {history ? "Hide history" : "Show history"}
      </button>
      <p role="status">{status}</p>
      {error && (
        <div role="alert">
          <p>{error}</p>
          {stale && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void reloadEvidence()}
            >
              Reload evidence
            </button>
          )}
        </div>
      )}
      {history && <History item={item} refreshKey={historyKey} />}
    </article>
  );
}

function RuleCard({
  rule,
  onChanged,
}: {
  rule: MetadataRuleView;
  onChanged: () => Promise<void>;
}) {
  const [version, setVersion] = useState("none");
  const [evidence, setEvidence] = useState("");
  const [reason, setReason] = useState("");
  const [code, setCode] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const target = `rule:${rule.kind}:${version === "none" ? 0 : Number(version)}`;
  const active =
    rule.active && rule.active.version !== null ? rule.active : null;

  async function sendCode() {
    setBusy(true);
    setError("");
    try {
      await requestMetadataCode(target, "activate_rule");
      setStatus("Fresh approval code sent to your email.");
    } catch (failure) {
      setStatus("");
      setError(codeError(failure));
    } finally {
      setBusy(false);
    }
  }
  async function apply() {
    setBusy(true);
    setError("");
    try {
      const result = await activateMetadataRule(rule.kind, {
        version: version === "none" ? null : Number(version),
        evidence_url: evidence.trim(),
        reason: reason.trim(),
        code,
      });
      setCode("");
      setStatus(
        `Rule change recorded for ${result.printings} Printings and ${result.editions} Editions. Public delivery: ${result.public_delivery}.` +
          (result.public_delivery === "pending"
            ? " A background drain is delivering the remaining changes; until it finishes the public store may still show the old eligibility. If it stays pending, run scripts/backfill_public_catalog.py (exit code 3 means another drain is still running; retry later)."
            : "")
      );
      await onChanged();
    } catch (failure) {
      setStatus("");
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <article aria-label={`Rule ${rule.kind}`}>
      <h4>{rule.kind}</h4>
      <p>
        {active
          ? `Active: version ${active.version} · activated ${when(active.activated_at)} · ${active.reason}`
          : "No active rule"}
      </p>
      {active && !active.digest_current && (
        <p role="alert">
          The rule code changed after approval, so it is inactive until you
          approve it again.
        </p>
      )}
      <ul>
        {rule.versions.map((entry) => (
          <li key={entry.version}>
            Version {entry.version} · digest {entry.code_digest.slice(0, 12)}
          </li>
        ))}
      </ul>
      <label>
        Rule version{" "}
        <select
          value={version}
          onChange={(event) => setVersion(event.target.value)}
        >
          <option value="none">No rule (deactivate)</option>
          {rule.versions.map((entry) => (
            <option key={entry.version} value={String(entry.version)}>
              {entry.version}
            </option>
          ))}
        </select>
      </label>
      <label>
        Rule evidence URL{" "}
        <input
          type="url"
          value={evidence}
          onChange={(event) => setEvidence(event.target.value)}
        />
      </label>
      <label>
        Rule reason{" "}
        <textarea
          value={reason}
          maxLength={2000}
          onChange={(event) => setReason(event.target.value)}
        />
      </label>
      <button type="button" disabled={busy} onClick={() => void sendCode()}>
        Send code
      </button>
      <label>
        Fresh six-digit code{" "}
        <input
          inputMode="numeric"
          pattern="[0-9]{6}"
          maxLength={6}
          value={code}
          onChange={(event) => setCode(event.target.value)}
        />
      </label>
      <button
        type="button"
        disabled={
          busy || !evidence.trim() || !reason.trim() || !looksLikeCode(code)
        }
        onClick={() => void apply()}
      >
        Apply rule change
      </button>
      <p role="status">{status}</p>
      {error && <p role="alert">{error}</p>}
    </article>
  );
}

export function MetadataReview() {
  const [items, setItems] = useState<MetadataQueueItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [rules, setRules] = useState<MetadataRuleView[]>([]);
  const [message, setMessage] = useState("");

  async function load(next?: string) {
    try {
      const page = await getMetadataQueue(next);
      setItems((previous) =>
        next ? [...previous, ...page.items] : page.items
      );
      setCursor(page.next_cursor);
      setMessage("");
    } catch {
      setMessage("Unable to load the metadata review queue.");
    }
  }
  async function loadRules() {
    try {
      setRules(await getMetadataRules());
    } catch {
      setMessage("Unable to load the metadata rules.");
    }
  }
  useEffect(() => {
    void load();
    void loadRules();
  }, []);
  const key = (item: MetadataQueueItem) =>
    `${item.kind}:${item.edition_id ?? item.printing_id}`;

  return (
    <section aria-label="Catalog metadata review">
      <h2>Catalog metadata review</h2>
      <p>
        Quarantined Editions, suspended Printings and collector reports. Nothing
        changes until you record a decision with a fresh code.
      </p>
      <button
        type="button"
        onClick={() => {
          void load();
          void loadRules();
        }}
      >
        Refresh queue
      </button>
      <p role="status">{message}</p>
      {items.length ? (
        items.map((item) => (
          <ReviewItem
            key={key(item)}
            item={item}
            onItem={(next) =>
              setItems((previous) =>
                previous.map((row) => (key(row) === key(next) ? next : row))
              )
            }
          />
        ))
      ) : (
        <p>No metadata targets need review.</p>
      )}
      {cursor && (
        <button type="button" onClick={() => void load(cursor)}>
          Load more
        </button>
      )}
      <section aria-label="Metadata rules">
        <h3>Metadata rules</h3>
        <p>
          Rules live in code. Activating a version records your approval for its
          exact code digest.
        </p>
        {rules.map((rule) => (
          <RuleCard key={rule.kind} rule={rule} onChanged={loadRules} />
        ))}
      </section>
    </section>
  );
}
