import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { usePlaces } from "../catalog/usePlaces";
import {
  changeCollectionImport,
  CollectionImportError,
  collectionImportSkippedHref,
  getCurrentCollectionImport,
  saveCollectionImport,
  type CollectionImportChange,
  type CollectionImportChangeResult,
  type CollectionImportGroup,
  type CollectionImportRowFilter,
  type CollectionImportSummary,
} from "../collection_import_generated";
import { PageHeader } from "../shell/PageHeader";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { Icon } from "../ui/Icon";
import { Menu } from "../ui/Menu";
import { Select } from "../ui/Select";
import { useToast } from "../ui/Toast";
import { ImportGroups } from "./ImportGroups";
import { ImportLeftOut } from "./ImportLeftOut";
import { ImportRowItem } from "./ImportRowItem";
import {
  BULK_FINISHES,
  cardsText,
  changeErrorText,
  finishText,
  groupText,
  heldText,
  pickText,
  rowsText,
  saveErrorText,
  saveStatusText,
  skipText,
} from "./importText";
import { useImportRows } from "./useImportRows";

type Props = {
  summary: CollectionImportSummary;
  /** What the review is of, shown before its row count: the file's name, or null for a continued import (#233). */
  label: string | null;
  /** Back to the upload, with the draft as the review last had it: it stays open there (#233). */
  onBack: (summary: CollectionImportSummary) => void;
  /** After a save: show the Storage Leaf the cards went to. */
  onLanded: (locationId: string) => void;
  /** The landing Storage Leaf, whenever the review changes it, so Back keeps it chosen. */
  onLocation?: (locationId: string) => void;
};

/** The rows a bulk change applies to: every row in the current filter (Select all), or these row numbers. */
type Selection = { all: boolean; rows: ReadonlySet<number> };
const NOTHING: Selection = { all: false, rows: new Set() };
// A change names at most this many rows by number (collection_import.MAX_CHANGE_ROWS); more go in several changes.
const MAX_CHANGE_ROWS = 1000;

const FILTERS: { value: CollectionImportRowFilter; label: string }[] = [
  { value: "needs", label: "Needs you" },
  { value: "finish", label: "Finish unknown" },
  { value: "name", label: "Matched by name" },
  { value: "all", label: "All" },
  { value: "skipped", label: "Skipped" },
];

const PANEL =
  "box-border flex flex-col gap-2 rounded-panel border border-border bg-surface p-4";

const NO_PENDING = { groups: {}, location: null };

const EMPTY: Record<CollectionImportRowFilter, string> = {
  needs: "Nothing needs you. Every row is ready or skipped.",
  finish: "No rows have an unknown finish.",
  name: "No rows were matched by name.",
  all: "Every row is skipped.",
  skipped: "No rows are skipped.",
};

// The Set finish… trigger, drawn as the kit's secondary Button (30 px, 44 px on a phone).
const BULK_TRIGGER =
  "box-border m-0 inline-flex h-control cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-control border border-border-strong bg-surface-raised px-3 font-sans text-control font-medium leading-none text-text hover:border-control-outline aria-expanded:border-accent-border aria-expanded:bg-surface-selected aria-expanded:text-accent-strong phone:h-control-phone phone:px-4";

/** Collection Import's review (#226, #229 to #231): one list of the file's rows under Needs you, Finish unknown, Matched
 * by name, All and Skipped, opening on Needs you when anything needs the collector. A row's finish is picked from its
 * card's own Editions; a row that needs a card opens its resolver (Fix: candidates, a catalog search, Skip row), and a
 * row matched by name or a Basic Energy can change its card (Change). Selected rows (or every row in the filter) get a
 * finish or are skipped at once, Skip all skips every row in Needs you, and skipped rows can be restored or downloaded
 * in the file's own columns. Every change goes to the server at the draft's revision and answers the new counts.
 * Finish unknown and Matched by name never block saving. Saving adds every ready row's copies in one step, with no
 * Undo. The side column (above the list on a phone) holds the summary, Put cards in (the landing Storage Leaf, which
 * can change until the save), In this file (the file's groups, which can be left out), the rows left out (#231) and
 * how many incoming cards the Collection already holds (#232). A save refused because the Location or a card changed
 * (REVIEW_CHANGED: the server has put those rows back under Needs you) or because the draft changed elsewhere reads the
 * draft again and opens on Needs you (#233). */
export function ImportReview({
  summary,
  label,
  onBack,
  onLanded,
  onLocation,
}: Props) {
  const places = usePlaces(true);
  const toast = useToast();
  const heading = useRef<HTMLHeadingElement>(null);
  const rowsHeading = useRef<HTMLHeadingElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [current, setCurrent] = useState(summary);
  const counts = current.counts;
  const [filter, setFilter] = useState<CollectionImportRowFilter>(
    summary.counts.needs_you > 0 ? "needs" : "all"
  );
  const list = useImportRows(current.id, filter);
  const [selection, setSelection] = useState<Selection>(NOTHING);
  const changing = useRef(false);
  // The newest summary the server answered, so a queued change goes at the revision the last one produced.
  const server = useRef(summary);
  // Group and Location changes made while a request is in flight (#232): sent together, in click order, once it
  // returns. `pending` is what the controls show meanwhile, so a ticked-off group stays unticked.
  const queued = useRef<{ change: CollectionImportChange; text: string }[]>([]);
  const [pending, setPending] = useState<{
    groups: Record<string, boolean>;
    location: string | null;
  }>(NO_PENDING);
  const [notice, setNotice] = useState("");
  // The row whose resolver is open, and the Fix or Change buttons, so Escape can return focus to the one that opened it.
  const [open, setOpen] = useState<number | null>(null);
  const toggles = useRef(new Map<number, HTMLButtonElement>());
  const [focusToggle, setFocusToggle] = useState<number | null>(null);
  // Where focus goes once the rows are read again, if the focused control left with its row or with the bulk bar.
  const [refocus, setRefocus] = useState<
    { to: "row"; index: number } | { to: "rows" } | null
  >(null);
  // One key per review, so a retried save after a lost response is the same save.
  const key = useRef(crypto.randomUUID());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const where =
    places.path(current.location_id) ??
    current.location_name ??
    "your Location";
  const shown: Record<CollectionImportRowFilter, number> = {
    needs: counts.needs_you,
    finish: counts.finish_unknown,
    name: counts.by_name,
    all: counts.needs_you + counts.ready,
    skipped: counts.skipped,
  };
  // A group or Location change is still on its way: saving now would leave it behind.
  const moving =
    pending.location !== null || Object.keys(pending.groups).length > 0;
  const selectedCount = selection.all ? shown[filter] : selection.rows.size;

  useEffect(() => {
    heading.current?.focus();
  }, []);

  useEffect(() => {
    onLocation?.(current.location_id);
  }, [current.location_id, onLocation]);

  useEffect(() => {
    if (focusToggle === null) return;
    setFocusToggle(null);
    toggles.current.get(focusToggle)?.focus();
  }, [focusToggle]);

  useEffect(() => {
    if (!refocus) return;
    setRefocus(null);
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    if (refocus.to === "row") {
      const items =
        listRef.current?.querySelectorAll<HTMLElement>("li[data-row]");
      const item = items?.[Math.min(refocus.index, items.length - 1)];
      const box = item?.querySelector<HTMLInputElement>(
        'input[type="checkbox"]'
      );
      if (box) return box.focus();
    }
    rowsHeading.current?.focus();
  }, [refocus, list.rows]);

  function choose(next: CollectionImportRowFilter) {
    setFilter(next);
    setSelection(NOTHING);
    setNotice("");
    setOpen(null);
  }

  function select(rowNumber: number, on: boolean) {
    setSelection((previous) => {
      const rows = new Set(
        previous.all ? list.rows.map((row) => row.row_number) : previous.rows
      );
      if (on) rows.add(rowNumber);
      else rows.delete(rowNumber);
      return { all: false, rows };
    });
  }

  /** The changes for this action on the selection: the filter for Select all, else the row numbers. */
  function selected(
    action: Omit<CollectionImportChange, "rows" | "filter">
  ): CollectionImportChange[] {
    if (selection.all) return [{ filter, ...action }];
    const rows = [...selection.rows].sort((a, b) => a - b);
    const changes: CollectionImportChange[] = [];
    for (let start = 0; start < rows.length; start += MAX_CHANGE_ROWS)
      changes.push({
        rows: rows.slice(start, start + MAX_CHANGE_ROWS),
        ...action,
      });
    return changes;
  }

  /** Sends the changes at the draft's revision, then shows the new counts and reads the shown rows again. */
  async function apply(
    changes: CollectionImportChange[],
    describe: (results: CollectionImportChangeResult[]) => string,
    after: { to: "row"; index: number } | { to: "rows" }
  ) {
    if (changing.current || !changes.length) return;
    changing.current = true;
    setNotice("");
    setError(null);
    try {
      const result = await changeCollectionImport(current.id, {
        draft_revision: server.current.draft_revision,
        changes,
      });
      server.current = result.summary;
      setCurrent(result.summary);
      setSelection(NOTHING);
      await list.refresh();
      setNotice(describe(result.results));
      setRefocus(after);
    } catch (failure) {
      const staleDraft =
        failure instanceof CollectionImportError &&
        failure.code === "STALE_DRAFT";
      const moves = changes.some(
        (item) => "group" in item || "location_id" in item
      );
      // A failed move, or a stale draft, drops what was queued behind it, and the controls show the server's state
      // again. Any other failure leaves the queue to go at the revision now held.
      if (staleDraft || moves) queued.current = [];
      if (staleDraft || moves) {
        const latest = await getCurrentCollectionImport().catch(() => null);
        if (latest?.id === current.id) {
          server.current = latest;
          setCurrent(latest);
          setSelection(NOTHING);
          await list.refresh();
          setRefocus(after);
        }
      }
      if (
        failure instanceof CollectionImportError &&
        failure.code === "NOT_STORAGE_LEAF"
      )
        places.reload();
      setNotice(changeErrorText(failure));
    } finally {
      changing.current = false;
      drain();
    }
  }

  /** Sends the group and Location changes queued while a request was in flight, as one request, in click order. The
   * controls keep showing them until the answer is in. */
  function drain() {
    const waiting = queued.current;
    if (!waiting.length) return setPending(NO_PENDING);
    queued.current = [];
    void apply(
      waiting.map((item) => item.change),
      () => waiting[waiting.length - 1].text,
      { to: "rows" }
    );
  }

  /** Group and Location changes: sent now, or queued behind the request in flight. The pending value shows at once. */
  function move(change: CollectionImportChange, text: string) {
    if (saving) return;
    setPending((previous) =>
      typeof change.group === "string"
        ? {
            ...previous,
            groups: {
              ...previous.groups,
              [change.group]: change.include === true,
            },
          }
        : { ...previous, location: change.location_id ?? null }
    );
    if (changing.current) queued.current.push({ change, text });
    else void apply([change], () => text, { to: "rows" });
  }

  function total(results: CollectionImportChangeResult[]) {
    return {
      applied: results.reduce((sum, item) => sum + item.applied, 0),
      notApplied: results.flatMap((item) => item.not_applied),
    };
  }

  function setFinish(
    changes: CollectionImportChange[],
    label: string,
    after: { to: "row"; index: number } | { to: "rows" }
  ) {
    void apply(
      changes,
      (results) => {
        const { applied, notApplied } = total(results);
        return finishText(label, applied, notApplied);
      },
      after
    );
  }

  function setSkipped(
    changes: CollectionImportChange[],
    skip: boolean,
    after: { to: "row"; index: number } | { to: "rows" }
  ) {
    void apply(
      changes,
      (results) => skipText(total(results).applied, skip),
      after
    );
  }

  /** A card picked in a row's resolver: the resolver closes, and focus goes to the row now in its place. */
  function pick(
    rowNumber: number,
    index: number,
    change: CollectionImportChange,
    card: string
  ) {
    setOpen(null);
    void apply(
      [change],
      (results) => pickText(rowNumber, card, total(results).applied),
      { to: "row", index }
    );
  }

  /** Put cards in: the landing Storage Leaf changes on the server, as any change does. */
  function moveTo(locationId: string) {
    if (locationId === (pending.location ?? current.location_id)) return;
    move(
      { location_id: locationId },
      `Cards will go to ${places.path(locationId) ?? "that Location"}.`
    );
  }

  /** In this file: leaves a group's rows out, or brings them back as they were. */
  function include(group: CollectionImportGroup, on: boolean) {
    move({ group: group.name, include: on }, groupText(group.name, on));
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const result = await saveCollectionImport(current.id, {
        draft_revision: current.draft_revision,
        idempotency_key: key.current,
      });
      toast.show({
        message: `Added ${cardsText(result.copy_count)} to ${where}.`,
      });
      onLanded(result.location_id);
    } catch (failure) {
      if (
        failure instanceof CollectionImportError &&
        (failure.code === "REVIEW_CHANGED" || failure.code === "STALE_DRAFT")
      )
        await reload();
      setError(saveErrorText(failure));
      setSaving(false);
    }
  }

  /** Reads the draft again after a refused save, and opens on Needs you when rows wait there. */
  async function reload() {
    const latest = await getCurrentCollectionImport().catch(() => null);
    if (latest?.id !== current.id) return;
    server.current = latest;
    setCurrent(latest);
    setSelection(NOTHING);
    setOpen(null);
    places.reload();
    if (latest.counts.needs_you > 0 && filter !== "needs") setFilter("needs");
    else await list.refresh();
  }

  return (
    <main className="mx-auto box-border flex w-full max-w-5xl flex-col gap-6 px-7 pt-6 phone:px-4 phone:pt-4">
      <div className="flex flex-col gap-1">
        <PageHeader
          title="Review import"
          headingRef={heading}
          actions={
            <Button variant="quiet" onClick={() => onBack(current)}>
              Back
            </Button>
          }
        />
        <p className="m-0 text-body text-text-muted wrap-anywhere">
          {[label, rowsText(counts.rows)].filter(Boolean).join(" · ")}
        </p>
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_16rem] items-start gap-6 phone:grid-cols-1">
        <section
          aria-labelledby="import-rows-heading"
          className="flex min-w-0 flex-col gap-3"
        >
          <h2
            id="import-rows-heading"
            ref={rowsHeading}
            tabIndex={-1}
            className="m-0 text-heading font-semibold"
          >
            Rows
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            <div
              role="group"
              aria-label="Show rows"
              className="flex flex-wrap gap-2"
            >
              {FILTERS.map((option) => (
                <Chip
                  key={option.value}
                  selected={filter === option.value}
                  onChange={() => choose(option.value)}
                >
                  {option.label} {shown[option.value]}
                </Chip>
              ))}
            </div>
            {shown[filter] > 0 && (
              <Button
                variant="quiet"
                aria-pressed={selection.all}
                onClick={() =>
                  setSelection(
                    selection.all ? NOTHING : { all: true, rows: new Set() }
                  )
                }
              >
                Select all {shown[filter]}
              </Button>
            )}
            {filter === "needs" && counts.needs_you > 0 && (
              <Button
                onClick={() => {
                  setOpen(null);
                  setSkipped([{ filter: "needs", skip: true }], true, {
                    to: "rows",
                  });
                }}
              >
                Skip all {counts.needs_you}
              </Button>
            )}
          </div>
          <p role="status" className="m-0 text-body text-text-muted">
            {notice}
          </p>
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
            <p className="m-0 text-body text-text-muted">{EMPTY[filter]}</p>
          )}
          {list.rows.length > 0 && (
            <ul
              ref={listRef}
              aria-labelledby="import-rows-heading"
              className="m-0 flex list-none flex-col p-0"
            >
              {list.rows.map((row, index) => (
                <ImportRowItem
                  key={row.row_number}
                  row={row}
                  lines={current.lines}
                  selected={selection.all || selection.rows.has(row.row_number)}
                  onSelect={(on) => select(row.row_number, on)}
                  onFinish={(descriptor, label) =>
                    setFinish(
                      [{ rows: [row.row_number], finish: descriptor }],
                      label,
                      { to: "row", index }
                    )
                  }
                  onSkip={() => {
                    setOpen(null);
                    setSkipped([{ rows: [row.row_number], skip: true }], true, {
                      to: "row",
                      index,
                    });
                  }}
                  onRestore={() =>
                    setSkipped(
                      [{ rows: [row.row_number], restore: true }],
                      false,
                      { to: "row", index }
                    )
                  }
                  open={open === row.row_number}
                  onToggle={() =>
                    setOpen((previous) =>
                      previous === row.row_number ? null : row.row_number
                    )
                  }
                  onClose={() => {
                    setOpen(null);
                    setFocusToggle(row.row_number);
                  }}
                  onPick={(choice, card) =>
                    pick(
                      row.row_number,
                      index,
                      { rows: [row.row_number], pick: choice },
                      card
                    )
                  }
                  toggleRef={(element) => {
                    if (element) toggles.current.set(row.row_number, element);
                    else toggles.current.delete(row.row_number);
                  }}
                />
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
          aria-label="About this import"
          className="flex min-w-0 flex-col gap-4 phone:order-first"
        >
          <section aria-labelledby="import-summary-heading" className={PANEL}>
            <h2
              id="import-summary-heading"
              className="m-0 text-heading font-semibold"
            >
              Import summary
            </h2>
            <dl className="m-0 grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 text-body">
              <dt className="text-text-muted">
                {current.lines ? "Rows in list" : "Rows in file"}
              </dt>
              <dd className="m-0 text-right tabular-nums">{counts.rows}</dd>
              <dt className="text-text-muted">Need you</dt>
              <dd className="m-0 text-right tabular-nums">
                {counts.needs_you}
              </dd>
              <dt className="text-text-muted">Ready</dt>
              <dd className="m-0 text-right tabular-nums">{counts.ready}</dd>
              <dt className="text-text-muted">Finish unknown</dt>
              <dd className="m-0 text-right tabular-nums">
                {counts.finish_unknown}
              </dd>
              <dt className="text-text-muted">Matched by name</dt>
              <dd className="m-0 text-right tabular-nums">{counts.by_name}</dd>
              <dt className="text-text-muted">Skipped</dt>
              <dd className="m-0 text-right tabular-nums">{counts.skipped}</dd>
              <dt className="text-text-muted">Cards to add</dt>
              <dd className="m-0 text-right tabular-nums">
                {current.cards_to_add}
              </dd>
            </dl>
          </section>
          <div className={PANEL}>
            <Select
              label="Put cards in"
              value={pending.location ?? current.location_id}
              disabled={places.state !== "ready" || saving}
              aria-describedby="import-review-place-help"
              onChange={(event) => moveTo(event.target.value)}
            >
              {!places.leaves.some(
                (leaf) => leaf.id === current.location_id
              ) && <option value={current.location_id}>{where}</option>}
              {places.leaves.map((leaf) => (
                <option key={leaf.id} value={leaf.id}>
                  {leaf.label}
                </option>
              ))}
            </Select>
            <p
              id="import-review-place-help"
              className="m-0 text-meta text-text-muted"
            >
              Every card goes here, whatever its group.
            </p>
          </div>
          <ImportGroups
            groups={current.groups.map((group) =>
              Object.hasOwn(pending.groups, group.name)
                ? { ...group, included: pending.groups[group.name] }
                : group
            )}
            onInclude={include}
          />
          <ImportLeftOut
            importId={current.id}
            lines={current.lines}
            leftOut={current.left_out}
          />
          {current.already_held !== "0" && (
            <p className={`${PANEL} m-0 text-meta text-text-muted`}>
              {heldText(current.already_held)}
            </p>
          )}
        </aside>
      </div>
      <div className="sticky bottom-0 z-(--layer-sticky) box-border flex flex-col border-t border-border bg-bg phone:bottom-tabbar">
        {selectedCount > 0 && (
          <div
            role="group"
            aria-label="Selected rows"
            className="flex flex-wrap items-center gap-2 border-b border-border py-2"
          >
            <p className="m-0 text-body font-medium tabular-nums">
              {selectedCount} selected
            </p>
            {filter !== "skipped" && (
              <Menu
                label="Set finish…"
                align="start"
                side="above"
                triggerClassName={BULK_TRIGGER}
                trigger={
                  <>
                    Set finish…
                    <Icon
                      icon={ChevronDown}
                      size={14}
                      className="text-text-muted"
                    />
                  </>
                }
                items={BULK_FINISHES.map((option) => ({
                  label: option.label,
                  onSelect: () =>
                    setFinish(
                      selected({ finish: option.descriptor }),
                      option.label,
                      { to: "rows" }
                    ),
                }))}
              />
            )}
            {filter === "skipped" ? (
              <Button
                onClick={() =>
                  setSkipped(selected({ restore: true }), false, {
                    to: "rows",
                  })
                }
              >
                Restore
              </Button>
            ) : (
              <Button
                onClick={() =>
                  setSkipped(selected({ skip: true }), true, { to: "rows" })
                }
              >
                Skip
              </Button>
            )}
            <Button
              variant="quiet"
              onClick={() => {
                setSelection(NOTHING);
                setRefocus({ to: "rows" });
              }}
            >
              Clear
            </Button>
          </div>
        )}
        <section
          aria-label="Save"
          className="flex flex-wrap items-center gap-3 py-3"
        >
          <p
            id="import-save-status"
            role="status"
            className={`m-0 min-w-0 flex-[1_1_14rem] text-body ${error ? "text-warning" : "text-text"}`}
          >
            {error ??
              saveStatusText(
                counts.needs_you,
                counts.ready,
                current.cards_to_add,
                counts.finish_unknown
              )}
          </p>
          {counts.skipped > 0 && (
            <a
              className="inline-flex min-h-(--target-pointer) items-center text-meta text-accent underline underline-offset-2 hover:text-accent-strong phone:min-h-tap"
              href={collectionImportSkippedHref(current.id)}
              download={current.lines ? "skipped-rows.txt" : "skipped-rows.csv"}
            >
              Download skipped rows
            </a>
          )}
          <Button
            variant="primary"
            className="min-w-0 max-w-full"
            disabled={counts.needs_you > 0 || saving || moving}
            aria-describedby="import-save-status"
            onClick={() => void save()}
          >
            <span className="min-w-0 truncate">
              Add {cardsText(current.cards_to_add)} to {where}
            </span>
          </Button>
        </section>
      </div>
    </main>
  );
}
