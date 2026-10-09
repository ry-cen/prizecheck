import { useEffect, useState } from "react";
import { searchCatalog } from "./generated";
import {
  getCatalogReviews,
  getReviewEditions,
  decideCatalogReview,
  requestReviewCode,
  type CatalogReviewView,
  type CatalogDecision,
  type ReviewEditionView,
} from "./reconciliation_generated";
import { HoldingError } from "./holdings_generated";

function ReviewDecision({
  review,
  onDone,
}: {
  review: CatalogReviewView;
  onDone: () => void;
}) {
  const [decision, setDecision] = useState<CatalogDecision["decision"]>(
    review.kind === "source_match" ? "confirm_source" : "keep_existing"
  );
  const [reason, setReason] = useState("");
  const [evidence, setEvidence] = useState("");
  const [code, setCode] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const candidates = Array.isArray(review.candidate.manual_printing_ids)
    ? review.candidate.manual_printing_ids.filter(
        (id): id is string => typeof id === "string"
      )
    : [];
  const manualDetails = Array.isArray(review.candidate.manual_printings)
    ? (review.candidate.manual_printings as {
        id: string;
        name: string;
        set_name: string;
        collector_number: string;
      }[])
    : [];
  const [manual, setManual] = useState(candidates[0] ?? "");
  const [editions, setEditions] = useState<ReviewEditionView[]>([]);
  const [edition, setEdition] = useState("");
  const [replacement, setReplacement] = useState("");
  const [search, setSearch] = useState("");
  const [targets, setTargets] = useState<
    { id: string; printing: string; label: string }[]
  >([]);
  const [replacementPrinting, setReplacementPrinting] = useState("");
  const [mapping, setMapping] = useState<Record<string, string>>({});
  useEffect(() => {
    if (review.printing_id)
      void getReviewEditions(review.id)
        .then(setEditions)
        .catch(() => setMessage("Printing details unavailable. Retry."));
  }, [review.printing_id]);
  async function findTargets() {
    try {
      const r = await searchCatalog({ name: search });
      setTargets(
        r.printings.flatMap((p) =>
          p.editions
            .filter((e) => e.active)
            .map((e) => ({
              id: e.id,
              printing: p.id,
              label: `${p.name} · ${p.set_name} #${p.collector_number} · ${JSON.stringify(e.descriptor)}`,
            }))
        )
      );
    } catch {
      setMessage("Replacement search unavailable.");
    }
  }
  async function sendCode() {
    setBusy(true);
    try {
      await requestReviewCode(
        review.id,
        decision === "confirm_source" ? "confirm_source" : "resolve_catalog"
      );
      setMessage("Fresh review code sent to your email.");
    } catch {
      setMessage("Unable to send review code. Try again.");
    } finally {
      setBusy(false);
    }
  }
  async function submit() {
    setBusy(true);
    try {
      await decideCatalogReview(review.id, {
        evidence_digest: review.evidence_digest,
        decision,
        reason,
        evidence_url: evidence,
        code,
        manual_printing_id: manual || null,
        edition_id: edition || null,
        replacement_edition_id: replacement || null,
        replacement_printing_id: replacementPrinting || null,
        edition_replacements:
          decision === "deprecate_printing"
            ? editions.map((e) => ({
                edition_id: e.id,
                replacement_edition_id: mapping[e.id] ?? "",
              }))
            : [],
      });
      onDone();
    } catch (cause) {
      setMessage(
        cause instanceof HoldingError &&
          cause.code === "REVIEW_EVIDENCE_CHANGED"
          ? "Review evidence changed since it was shown. Refresh catalog reviews and check the new evidence."
          : cause instanceof HoldingError
            ? `Review failed: ${cause.code}. Check evidence and request a fresh code if needed.`
            : "Review unavailable. Retry."
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <article>
      <h3>
        {review.kind} · {review.source_id}
      </h3>
      <p>{review.detail}</p>
      <p>Incoming name: {String(review.candidate.name ?? "Unspecified")}.</p>
      <label>
        Review decision{" "}
        <select
          value={decision}
          onChange={(e) => {
            setDecision(e.target.value as CatalogDecision["decision"]);
            setCode("");
          }}
        >
          <option value="keep_existing">Keep existing physical identity</option>
          {review.kind === "source_match" && (
            <option value="confirm_source">
              Confirm same physical Printing
            </option>
          )}
          {review.printing_id && (
            <>
              <option value="deprecate_edition">
                Deprecate an Edition and link replacement
              </option>
              <option value="deprecate_printing">
                Deprecate Printing and map every Edition
              </option>
            </>
          )}
        </select>
      </label>
      {decision === "confirm_source" && (
        <label>
          Verified manual Printing{" "}
          <select value={manual} onChange={(e) => setManual(e.target.value)}>
            {candidates.map((id) => (
              <option key={id} value={id}>
                {manualDetails.find((p) => p.id === id)
                  ? `${manualDetails.find((p) => p.id === id)!.name} · ${manualDetails.find((p) => p.id === id)!.set_name} #${manualDetails.find((p) => p.id === id)!.collector_number}`
                  : id}
              </option>
            ))}
          </select>
        </label>
      )}
      {(decision === "deprecate_edition" ||
        decision === "deprecate_printing") && (
        <>
          <p>
            Create an evidenced replacement through Missing cards first if
            needed. Existing Holdings stay unchanged until their collector
            explicitly reassigns them.
          </p>
          {decision === "deprecate_edition" && (
            <label>
              Incorrect Edition{" "}
              <select
                value={edition}
                onChange={(e) => setEdition(e.target.value)}
              >
                <option value="">Choose Edition</option>
                {editions.map((e) => (
                  <option key={e.id} value={e.id}>
                    {JSON.stringify(e.descriptor)}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            Replacement name{" "}
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              maxLength={120}
            />
          </label>
          <button onClick={() => void findTargets()}>Find replacement</button>
          {decision === "deprecate_edition" && (
            <label>
              Replacement Edition{" "}
              <select
                value={replacement}
                onChange={(e) => setReplacement(e.target.value)}
              >
                <option value="">Choose replacement</option>
                {targets.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {decision === "deprecate_printing" && (
            <>
              <label>
                Replacement Printing{" "}
                <select
                  value={replacementPrinting}
                  onChange={(e) => {
                    setReplacementPrinting(e.target.value);
                    setMapping({});
                  }}
                >
                  <option value="">Choose replacement Printing</option>
                  {[...new Set(targets.map((t) => t.printing))].map((id) => (
                    <option key={id} value={id}>
                      {targets.find((t) => t.printing === id)?.label}
                    </option>
                  ))}
                </select>
              </label>
              {editions.map((e) => (
                <label key={e.id}>
                  Replacement for {JSON.stringify(e.descriptor)}{" "}
                  <select
                    value={mapping[e.id] ?? ""}
                    onChange={(event) =>
                      setMapping({ ...mapping, [e.id]: event.target.value })
                    }
                  >
                    <option value="">Choose physical Edition</option>
                    {targets
                      .filter((t) => t.printing === replacementPrinting)
                      .map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.label}
                        </option>
                      ))}
                  </select>
                </label>
              ))}
            </>
          )}
        </>
      )}
      <label>
        Review reason{" "}
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={2000}
        />
      </label>
      <label>
        Review evidence URL{" "}
        <input
          type="url"
          value={evidence}
          onChange={(e) => setEvidence(e.target.value)}
        />
      </label>
      <button disabled={busy} onClick={() => void sendCode()}>
        Send review code
      </button>
      <label>
        Fresh review code{" "}
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          inputMode="numeric"
          pattern="[0-9]{6}"
          maxLength={6}
        />
      </label>
      <button
        disabled={busy || !reason.trim() || !evidence || !/^\d{6}$/.test(code)}
        onClick={() => void submit()}
      >
        Confirm catalog decision
      </button>
      {message && <p role="status">{message}</p>}
    </article>
  );
}
export function CatalogReview() {
  const [reviews, setReviews] = useState<CatalogReviewView[]>([]);
  const [message, setMessage] = useState("");
  async function load() {
    try {
      setReviews(await getCatalogReviews());
    } catch {
      setMessage("Catalog reviews unavailable.");
    }
  }
  useEffect(() => {
    void load();
  }, []);
  return (
    <section aria-label="Catalog reconciliation">
      <h2>Catalog reconciliation</h2>
      <p>
        Source drift waits for evidenced owner review. Confirming a source
        reference preserves application identities and does not move physical
        copies.
      </p>
      {reviews.map((r) => (
        <ReviewDecision key={r.id} review={r} onDone={() => void load()} />
      ))}
      {!reviews.length && <p>No pending catalog reviews.</p>}
      {message && <p role="status">{message}</p>}
      <button onClick={() => void load()}>Refresh catalog reviews</button>
    </section>
  );
}
