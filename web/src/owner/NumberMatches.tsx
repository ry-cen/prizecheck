import { useEffect, useRef, useState } from "react";
import { editionLabel, errorText } from "../MetadataReview";
import {
  decideMetadata,
  getMetadataQueue,
  type MetadataQueueItem,
} from "../metadata_generated";
import { Button } from "../ui/Button";
import { TextArea, TextField } from "../ui/TextField";
import { useToast } from "../ui/Toast";
import {
  CARD_HEADING,
  FIELDS,
  ReviewCard,
  ReviewQueue,
  type QueueRow,
} from "./ReviewQueue";

const COLUMNS = ["Card", "Set · number", "TCGplayer product", "Rule"] as const;

const label = (item: MetadataQueueItem) =>
  `${item.name ?? "Unnamed Printing"} · ${editionLabel(item.descriptor)}`;

function productText(item: MetadataQueueItem) {
  const product = item.matched_product;
  if (!product) return "—";
  return `${product.name ?? "Unnamed product"} (product ${product.product_id}${product.group_id == null ? "" : `, group ${product.group_id}`})`;
}

const key = (item: MetadataQueueItem) => item.edition_id ?? item.printing_id;

function row(item: MetadataQueueItem): QueueRow {
  return {
    key: key(item),
    label: label(item),
    card: label(item),
    setNumber: item.set_id ? `${item.set_id} #${item.collector_number}` : "—",
    kind: productText(item),
    reports: item.rule_version == null ? "—" : `v${item.rule_version}`,
    opened: null,
  };
}

function RejectCard({
  item,
  onClose,
  onRejected,
}: {
  item: MetadataQueueItem;
  onClose: () => void;
  onRejected: (message: string) => void;
}) {
  const reasonField = useRef<HTMLTextAreaElement>(null);
  const [reason, setReason] = useState("");
  const [evidence, setEvidence] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function reject() {
    setBusy(true);
    setError("");
    try {
      const result = await decideMetadata({
        target: item.target,
        printing_id: item.printing_id,
        edition_id: item.edition_id,
        decision: "reject_source",
        reviewed_value: null,
        basis_revision: item.basis_revision,
        evidence_digest: item.evidence_digest,
        evidence_url: evidence.trim(),
        reason: reason.trim(),
        report_ids: [],
      });
      onRejected(
        `Match rejected: ${result.state.replace(/_/g, " ")}${result.reason ? ` (${result.reason})` : ""}.`
      );
    } catch (failure) {
      setError(errorText(failure));
      setBusy(false);
    }
  }

  return (
    <ReviewCard title={label(item)} onClose={onClose} focusRef={reasonField}>
      <p className="m-0 text-meta text-text-muted">
        {item.set_id ? `${item.set_id} #${item.collector_number} · ` : ""}
        Matched by card number to {productText(item)}
        {item.rule_version == null
          ? ""
          : ` · matching rule v${item.rule_version}`}
      </p>
      <h4 className={CARD_HEADING}>Reject this match</h4>
      <p className="m-0 text-meta text-text-muted">
        The Edition becomes unverified and loses its product and price. A later
        rule activation or re-match does not verify it again.
      </p>
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
      <div>
        <Button
          variant="danger"
          disabled={busy || !reason.trim() || !evidence.trim()}
          onClick={() => void reject()}
        >
          Reject match
        </Button>
      </div>
      {error && (
        <p role="alert" className="m-0 text-meta text-danger">
          {error}
        </p>
      )}
    </ReviewCard>
  );
}

/** Owner controls' "Matched by card number" view (#347): verified Editions the card-number path matched, each with
 * the product it named and a Reject match decision. */
export function NumberMatches({ onChanged }: { onChanged: () => void }) {
  const [items, setItems] = useState<MetadataQueueItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const toast = useToast();

  async function load(next?: string) {
    try {
      const page = await getMetadataQueue(next, "card_number");
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
      setMessage("Unable to load the card-number matches.");
    }
  }
  useEffect(() => {
    void load();
  }, []);

  return (
    <ReviewQueue
      title="Matched by card number"
      intro="Editions verified by the card-number rule rather than a product ID. Reject a match that names the wrong product."
      tableLabel="Card-number matches"
      columns={COLUMNS}
      rows={items.map(row)}
      emptyText="No Editions are matched by card number."
      open={open}
      onOpen={setOpen}
      renderCard={(rowKey, close) => {
        const item = items.find((entry) => key(entry) === rowKey);
        return (
          item && (
            <RejectCard
              key={rowKey}
              item={item}
              onClose={close}
              onRejected={(text) => {
                setItems((previous) =>
                  previous.filter((entry) => entry !== item)
                );
                setOpen(null);
                toast.show({ message: `${label(item)}: ${text}` });
                onChanged();
              }}
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
