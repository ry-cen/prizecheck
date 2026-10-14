import { useEffect, useRef, useState } from "react";
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
import { ScrollTable } from "./ui/ScrollTable";
import { Select } from "./ui/Select";
import { TextArea, TextField } from "./ui/TextField";
import { useToast } from "./ui/Toast";
import { variantLabel } from "./ui/variantLabel";

const text = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : null;

/** The card a review is about: the Printing as recorded, else the incoming record's name. */
function cardName(review: CatalogReviewView) {
  return review.current_name ?? text(review.candidate.name) ?? "Unnamed card";
}

function setNumber(review: CatalogReviewView) {
  const set = review.current_set_id ?? text(review.candidate.set_id);
  const number =
    review.current_collector_number ?? text(review.candidate.collector_number);
  return set ? `${set} #${number ?? "?"}` : "—";
}

function row(review: CatalogReviewView): QueueRow {
  return {
    key: review.id,
    label: `${cardName(review)} · ${review.source_id}`,
    card: (
      <>
        {cardName(review)}{" "}
        <span className="text-text-muted">{review.source_id}</span>
      </>
    ),
    setNumber: setNumber(review),
    kind: review.kind.replace(/_/g, " "),
    reports: "—",
    opened: review.created_at,
  };
}

/** The incoming change beside the Printing as recorded, field by field. */
function IncomingChange({ review }: { review: CatalogReviewView }) {
  const fields: [string, string | null | undefined, unknown][] = [
    ["Name", review.current_name, review.candidate.name],
    ["Set ID", review.current_set_id, review.candidate.set_id],
    ["Set name", review.current_set_name, review.candidate.set_name],
    [
      "Collector number",
      review.current_collector_number,
      review.candidate.collector_number,
    ],
  ];
  const shown = fields.filter(
    ([, recorded, incoming]) => recorded || text(incoming)
  );
  if (!shown.length) return null;
  return (
    <ScrollTable label="Incoming change">
      <thead>
        <tr>
          <th scope="col">Field</th>
          <th scope="col">Recorded</th>
          <th scope="col">Incoming</th>
        </tr>
      </thead>
      <tbody>
        {shown.map(([field, recorded, incoming]) => (
          <tr key={field}>
            <td>
              {field}{" "}
              {recorded && text(incoming) && recorded !== text(incoming) && (
                <Differs />
              )}
            </td>
            <td>{recorded ?? "—"}</td>
            <td>{text(incoming) ?? "—"}</td>
          </tr>
        ))}
      </tbody>
    </ScrollTable>
  );
}

function ReviewDecision({
  review,
  onClose,
  onDone,
}: {
  review: CatalogReviewView;
  onClose: () => void;
  onDone: (result: CatalogReviewView) => void;
}) {
  const [decision, setDecision] = useState<CatalogDecision["decision"]>(
    review.kind === "source_match" ? "confirm_source" : "keep_existing"
  );
  const [reason, setReason] = useState("");
  const [evidence, setEvidence] = useState("");
  const [code, setCode] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const reasonField = useRef<HTMLTextAreaElement>(null);
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
  const deprecating =
    decision === "deprecate_edition" || decision === "deprecate_printing";
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
              label: `${p.name} · ${p.set_name} #${p.collector_number} · ${variantLabel(e.descriptor)}`,
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
      const result = await decideCatalogReview(review.id, {
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
      onDone(result);
    } catch (cause) {
      setMessage(
        cause instanceof HoldingError &&
          cause.code === "REVIEW_EVIDENCE_CHANGED"
          ? "Review evidence changed since it was shown. Refresh the queue and check the new evidence."
          : cause instanceof HoldingError
            ? `Review failed: ${cause.code}. Check evidence and request a fresh code if needed.`
            : "Review unavailable. Retry."
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <ReviewCard
      title={`${cardName(review)} · ${review.source_id}`}
      onClose={onClose}
      focusRef={reasonField}
    >
      <p className="m-0">{review.detail}</p>
      <IncomingChange review={review} />
      <div className={FIELDS}>
        <TextArea
          ref={reasonField}
          label="Review reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={2000}
        />
        <TextField
          label="Review evidence URL"
          type="url"
          value={evidence}
          onChange={(e) => setEvidence(e.target.value)}
        />
      </div>
      <h4 className={CARD_HEADING}>Decide</h4>
      <div className={FIELDS}>
        <Select
          label="Decision"
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
        </Select>
        {decision === "confirm_source" && (
          <Select
            label="Verified manual Printing"
            value={manual}
            onChange={(e) => setManual(e.target.value)}
          >
            {candidates.map((id) => {
              const detail = manualDetails.find((p) => p.id === id);
              return (
                <option key={id} value={id}>
                  {detail
                    ? `${detail.name} · ${detail.set_name} #${detail.collector_number}`
                    : id}
                </option>
              );
            })}
          </Select>
        )}
        {decision === "deprecate_edition" && (
          <Select
            label="Incorrect Edition"
            value={edition}
            onChange={(e) => setEdition(e.target.value)}
          >
            <option value="">Choose Edition</option>
            {editions.map((e) => (
              <option key={e.id} value={e.id}>
                {variantLabel(e.descriptor)}
              </option>
            ))}
          </Select>
        )}
      </div>
      {deprecating && (
        <>
          <p className="m-0 text-meta text-text-muted">
            Create an evidenced replacement through Missing cards first if
            needed. Existing Holdings stay unchanged until their collector
            explicitly reassigns them.
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-0 grow basis-60">
              <TextField
                label="Replacement name"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                maxLength={120}
              />
            </div>
            <Button onClick={() => void findTargets()}>Find replacement</Button>
          </div>
          {decision === "deprecate_edition" && (
            <Select
              label="Replacement Edition"
              value={replacement}
              onChange={(e) => setReplacement(e.target.value)}
            >
              <option value="">Choose replacement</option>
              {targets.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </Select>
          )}
          {decision === "deprecate_printing" && (
            <Select
              label="Replacement Printing"
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
            </Select>
          )}
        </>
      )}
      {editions.length > 0 && (
        <>
          <p className="m-0 text-meta text-text-muted">
            Holdings: copies of each Edition across every collection.
          </p>
          <ScrollTable label="Edition mapping">
            <thead>
              <tr>
                <th scope="col">Edition</th>
                <th scope="col">Holdings</th>
                {decision === "deprecate_printing" && (
                  <th scope="col">Replacement Edition</th>
                )}
              </tr>
            </thead>
            <tbody>
              {editions.map((e) => (
                <tr key={e.id}>
                  <td>{variantLabel(e.descriptor)}</td>
                  <td className="tabular-nums">{e.holdings}</td>
                  {decision === "deprecate_printing" && (
                    <td className="min-w-56 py-1.5">
                      <Select
                        label={`Replacement for ${variantLabel(e.descriptor)}`}
                        labelHidden
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
                      </Select>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </ScrollTable>
        </>
      )}
      <CodeStep
        onSend={() => void sendCode()}
        code={code}
        onCode={setCode}
        confirmLabel="Confirm decision"
        ready={!!reason.trim() && !!evidence}
        busy={busy}
        onConfirm={() => void submit()}
      />
      <p role="status" className="m-0 text-meta">
        {message}
      </p>
    </ReviewCard>
  );
}

/**
 * Owner controls' Catalog queue (#168): pending catalog reviews as a ScrollTable. A review's card shows the
 * incoming change beside the Printing as recorded, every Edition with its Holdings, and the decision with
 * a reason, a review evidence URL and a fresh code. A confirmed decision removes the row and shows a toast.
 */
export function CatalogReview({ onChanged }: { onChanged: () => void }) {
  const [reviews, setReviews] = useState<CatalogReviewView[]>([]);
  const [message, setMessage] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const toast = useToast();
  async function load() {
    try {
      const next = await getCatalogReviews();
      setReviews(next);
      setOpen((current) =>
        current && next.some((review) => review.id === current) ? current : null
      );
      setMessage("");
    } catch {
      setMessage("Catalog reviews unavailable.");
    }
  }
  useEffect(() => {
    void load();
  }, []);
  function decided(review: CatalogReviewView, result: CatalogReviewView) {
    setReviews((previous) => previous.filter((r) => r.id !== review.id));
    setOpen(null);
    toast.show({
      message: `Catalog decision recorded for ${cardName(review)}: ${result.status}.`,
    });
    onChanged();
  }
  return (
    <ReviewQueue
      title="Catalog reconciliation"
      intro="Source drift waits for evidenced owner review. Confirming a source reference preserves application identities and does not move physical copies."
      tableLabel="Pending catalog reviews"
      rows={reviews.map(row)}
      emptyText="No pending catalog reviews."
      open={open}
      onOpen={setOpen}
      renderCard={(key, close) => {
        const review = reviews.find((r) => r.id === key);
        return (
          review && (
            <ReviewDecision
              key={review.id}
              review={review}
              onClose={close}
              onDone={(result) => decided(review, result)}
            />
          )
        );
      }}
      onRefresh={() => void load()}
      status={message}
    />
  );
}
