import { useEffect, useRef, useState } from "react";
import { usePlaces } from "../catalog/usePlaces";
import {
  saveCollectionImport,
  type CollectionImportRow,
  type CollectionImportRowFilter,
  type CollectionImportSummary,
} from "../collection_import_generated";
import { PageHeader } from "../shell/PageHeader";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { Pill, type PillTone } from "../ui/Pill";
import { useToast } from "../ui/Toast";
import { variantLabel } from "../ui/variantLabel";
import {
  cardsText,
  rowsText,
  saveErrorText,
  saveStatusText,
} from "./importText";
import { useImportRows } from "./useImportRows";

type Props = {
  summary: CollectionImportSummary;
  fileName: string;
  onBack: () => void;
  /** After a save: show the Storage Leaf the cards went to. */
  onLanded: (locationId: string) => void;
};

/** How a row that isn't simply matched is marked. */
const PILLS: Partial<
  Record<CollectionImportRow["status"], { text: string; tone: PillTone }>
> = {
  ambiguous: { text: "More than one match", tone: "warn" },
  not_found: { text: "Not found", tone: "bad" },
  unreadable: { text: "Can't read", tone: "bad" },
  finish_unknown: { text: "Finish unknown", tone: "neutral" },
};

/** Collection Import's review (#226): one list of the file's rows with Needs you and All, opening on Needs you when
 * anything needs the collector, and the save bar. Rows that need the collector can't be fixed here yet (#229); the
 * collector fixes the file and imports it again. Saving adds every ready row's copies in one step, with no Undo. */
export function ImportReview({ summary, fileName, onBack, onLanded }: Props) {
  const places = usePlaces(true);
  const toast = useToast();
  const heading = useRef<HTMLHeadingElement>(null);
  const { rows, needs_you: needsYou, ready } = summary.counts;
  const [filter, setFilter] = useState<CollectionImportRowFilter>(
    needsYou > 0 ? "needs" : "all"
  );
  const list = useImportRows(summary.id, filter);
  // One key per review, so a retried save after a lost response is the same save.
  const key = useRef(crypto.randomUUID());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const where =
    places.path(summary.location_id) ??
    summary.location_name ??
    "your Location";

  useEffect(() => {
    heading.current?.focus();
  }, []);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const result = await saveCollectionImport(summary.id, {
        draft_revision: summary.draft_revision,
        idempotency_key: key.current,
      });
      toast.show({
        message: `Added ${cardsText(result.copy_count)} to ${where}.`,
      });
      onLanded(result.location_id);
    } catch (failure) {
      setError(saveErrorText(failure));
      setSaving(false);
    }
  }

  return (
    <main className="mx-auto box-border flex w-full max-w-5xl flex-col gap-6 px-7 pt-6 phone:px-4 phone:pt-4">
      <div className="flex flex-col gap-1">
        <PageHeader
          title="Review import"
          headingRef={heading}
          actions={
            <Button variant="quiet" onClick={onBack}>
              Back
            </Button>
          }
        />
        <p className="m-0 text-body text-text-muted wrap-anywhere">
          {fileName} · {rowsText(rows)}
        </p>
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_16rem] items-start gap-6 phone:grid-cols-1">
        <section
          aria-labelledby="import-rows-heading"
          className="flex min-w-0 flex-col gap-3"
        >
          <h2
            id="import-rows-heading"
            className="m-0 text-heading font-semibold"
          >
            Rows
          </h2>
          <div
            role="group"
            aria-label="Show rows"
            className="flex flex-wrap gap-2"
          >
            <Chip
              selected={filter === "needs"}
              onChange={() => setFilter("needs")}
            >
              Needs you {needsYou}
            </Chip>
            <Chip selected={filter === "all"} onChange={() => setFilter("all")}>
              All {rows}
            </Chip>
          </div>
          {list.status === "loading" && (
            <p className="m-0 text-body text-text-muted">Loading rows…</p>
          )}
          {list.status === "failed" && (
            <div className="flex flex-wrap items-center gap-3">
              <p className="m-0 text-body text-warning">
                The rows didn&apos;t load.
              </p>
              <Button onClick={list.retry}>Try again</Button>
            </div>
          )}
          {list.status === "ready" && list.rows.length === 0 && (
            <p className="m-0 text-body text-text-muted">
              {filter === "needs"
                ? "Nothing needs you. Every row is ready."
                : "This import has no rows."}
            </p>
          )}
          {list.rows.length > 0 && (
            <ul
              aria-labelledby="import-rows-heading"
              className="m-0 flex list-none flex-col p-0"
            >
              {list.rows.map((row) => (
                <ImportRowItem key={row.row_number} row={row} />
              ))}
            </ul>
          )}
          {list.more && list.status === "ready" && (
            <Button
              className="self-start"
              disabled={list.loadingMore}
              onClick={list.loadMore}
            >
              Show more rows
            </Button>
          )}
        </section>
        <aside
          aria-labelledby="import-summary-heading"
          className="box-border flex flex-col gap-2 rounded-panel border border-border bg-surface p-4 phone:order-first"
        >
          <h2
            id="import-summary-heading"
            className="m-0 text-heading font-semibold"
          >
            Import summary
          </h2>
          <dl className="m-0 grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 text-body">
            <dt className="text-text-muted">Rows in file</dt>
            <dd className="m-0 text-right tabular-nums">{rows}</dd>
            <dt className="text-text-muted">Need you</dt>
            <dd className="m-0 text-right tabular-nums">{needsYou}</dd>
            <dt className="text-text-muted">Ready</dt>
            <dd className="m-0 text-right tabular-nums">{ready}</dd>
            <dt className="text-text-muted">Cards to add</dt>
            <dd className="m-0 text-right tabular-nums">
              {summary.cards_to_add}
            </dd>
            <dt className="text-text-muted">Going to</dt>
            <dd className="m-0 text-right wrap-anywhere">{where}</dd>
          </dl>
        </aside>
      </div>
      <section
        aria-label="Save"
        className="sticky bottom-0 z-(--layer-sticky) box-border flex flex-wrap items-center gap-3 border-t border-border bg-bg py-3 phone:bottom-tabbar"
      >
        <p
          role="status"
          className={`m-0 min-w-0 flex-[1_1_14rem] text-body ${error ? "text-warning" : "text-text"}`}
        >
          {error ?? saveStatusText(needsYou, ready, summary.cards_to_add)}
        </p>
        <Button
          variant="primary"
          className="min-w-0 max-w-full"
          disabled={needsYou > 0 || saving}
          onClick={() => void save()}
        >
          <span className="min-w-0 truncate">
            Add {cardsText(summary.cards_to_add)} to {where}
          </span>
        </Button>
      </section>
    </main>
  );
}

function ImportRowItem({ row }: { row: CollectionImportRow }) {
  const pill = PILLS[row.status];
  const { source } = row;
  const fromFile = [
    source.quantity,
    source.name,
    source.set_name,
    source.number,
    source.finish,
  ]
    .filter(Boolean)
    .join(" · ");
  const title = row.card
    ? `${row.quantity ?? "?"} × ${row.card.name}`
    : source.name || `Row ${row.row_number}`;
  const detail = row.card
    ? [
        `${row.card.set_name} ${row.card.collector_number}`,
        row.edition ? variantLabel(row.edition.descriptor) : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : null;
  return (
    <li className="flex flex-wrap items-start gap-x-3 gap-y-1 border-b border-border py-3 last:border-b-0">
      <div className="flex min-w-0 flex-[1_1_16rem] flex-col gap-0.5">
        <p className="m-0 text-body font-semibold wrap-anywhere">{title}</p>
        {detail && (
          <p className="m-0 text-meta text-text-muted wrap-anywhere">
            {detail}
          </p>
        )}
        <p className="m-0 text-meta text-text-muted wrap-anywhere">
          From your file: {fromFile || "an empty row"}
        </p>
      </div>
      <span className="text-meta text-text-muted tabular-nums">
        Row {row.row_number}
      </span>
      {pill && <Pill tone={pill.tone}>{pill.text}</Pill>}
    </li>
  );
}
