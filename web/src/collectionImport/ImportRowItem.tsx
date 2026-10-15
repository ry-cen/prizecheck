import type { Ref } from "react";
import { ChevronDown } from "lucide-react";
import type {
  CollectionImportPick,
  CollectionImportRow,
} from "../collection_import_generated";
import { Button } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { Menu } from "../ui/Menu";
import { Pill, type PillTone } from "../ui/Pill";
import { variantLabel } from "../ui/variantLabel";
import { ImportRowResolver } from "./ImportRowResolver";
import { otherCandidates } from "./importText";

type Props = {
  row: CollectionImportRow;
  /** The import is a pasted list read line by line (#234): the row is a line the collector pasted. */
  lines: boolean;
  selected: boolean;
  onSelect: (selected: boolean) => void;
  /** Set this row's finish to one of its card's Editions (its descriptor, and the label the collector saw). */
  onFinish: (descriptor: Record<string, unknown>, label: string) => void;
  onSkip: () => void;
  onRestore: () => void;
  /** Whether this row's resolver is open. */
  open: boolean;
  /** Fix or Change: open or close the resolver. */
  onToggle: () => void;
  /** Escape in the resolver. */
  onClose: () => void;
  /** A card picked in the resolver, and how the notice names it. */
  onPick: (pick: CollectionImportPick, card: string) => void;
  /** The Fix or Change button, so focus can go back to it. */
  toggleRef: Ref<HTMLButtonElement>;
};

/** How a row that isn't simply matched is marked. A row whose card is known but whose finish isn't, on a card with no
 * Unspecified Variant, needs its finish picked; one with several cards it could be is Pick one (#229). */
function pillOf(
  row: CollectionImportRow
): { text: string; tone: PillTone } | null {
  if (row.skipped) return { text: "Skipped", tone: "neutral" };
  switch (row.status) {
    case "ambiguous":
      return row.card
        ? { text: "Pick a finish", tone: "warn" }
        : { text: "Pick one", tone: "warn" };
    case "not_found":
      return { text: "Not found", tone: "bad" };
    case "unreadable":
      return { text: "Can't read", tone: "bad" };
    case "finish_unknown":
      return { text: "Finish unknown", tone: "neutral" };
    case "by_name":
      return { text: "Matched by name", tone: "neutral" };
    default:
      return null;
  }
}

// The finish picker's trigger, drawn as the kit's secondary Button (30 px, 44 px on a phone).
const FINISH_TRIGGER =
  "box-border m-0 inline-flex h-control max-w-full min-w-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-control border border-border-strong bg-surface-raised px-3 font-sans text-control font-medium leading-none text-text hover:border-control-outline aria-expanded:border-accent-border aria-expanded:bg-surface-selected aria-expanded:text-accent-strong phone:h-control-phone phone:px-4";

/** One row of Collection Import's review (#226, #229, #230, #232): what the file said and what it matched, its group
 * and the copies already in the Collection, a checkbox for
 * bulk changes, the finish picker (the card's own Editions, when it has more than one), Skip or Restore, and the
 * resolver: Fix on a row that needs a card (Pick one, Not found, Can't read), Change on a row with a card the collector picked,
 * one matched by name, or a Basic Energy with other Printings. */
export function ImportRowItem({
  row,
  lines,
  selected,
  onSelect,
  onFinish,
  onSkip,
  onRestore,
  open,
  onToggle,
  onClose,
  onPick,
  toggleRef,
}: Props) {
  const pill = pillOf(row);
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
  const picker = !row.skipped && row.card && row.editions.length > 1;
  const finish = row.edition ? variantLabel(row.edition.descriptor) : null;
  const detail = row.card
    ? [
        `${row.card.set_name} ${row.card.collector_number}`,
        picker ? null : finish,
      ]
        .filter(Boolean)
        .join(" · ")
    : null;
  const shown = finish ?? "Pick a finish";
  // The row's group in the file, and the copies of its Card Edition already in the Collection (#232).
  const about = [
    row.group,
    row.held !== "0" ? `${row.held} already in your Collection` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const fix = !row.skipped && row.needs_you && !row.card;
  // Any row with a card the collector may still change: one they picked, one matched by name, one with other
  // Printings to choose (a Basic Energy), including a card still waiting for its finish.
  const change =
    !row.skipped &&
    row.card !== null &&
    (row.picked || row.by_name || otherCandidates(row).length > 0);
  const resolverLabel = fix
    ? `Fix row ${row.row_number}`
    : `Change card of row ${row.row_number}`;
  return (
    <li
      data-row={row.row_number}
      className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2 border-b border-border py-3 last:border-b-0"
    >
      <label className="inline-flex size-control cursor-pointer items-center justify-center phone:size-tap">
        <input
          type="checkbox"
          className="m-0 size-4 accent-accent"
          aria-label={`Select row ${row.row_number}`}
          checked={selected}
          onChange={(event) => onSelect(event.currentTarget.checked)}
        />
      </label>
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <p className="m-0 text-body font-semibold wrap-anywhere">{title}</p>
          {pill && <Pill tone={pill.tone}>{pill.text}</Pill>}
        </div>
        {detail && (
          <p className="m-0 text-meta text-text-muted wrap-anywhere">
            {detail}
          </p>
        )}
        {about && (
          <p className="m-0 text-meta text-text-muted wrap-anywhere">{about}</p>
        )}
        <p className="m-0 text-meta text-text-muted wrap-anywhere">
          {lines ? "You pasted" : "From your file"}:{" "}
          {fromFile || "an empty row"}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {picker && (
            <Menu
              label={`Finish of row ${row.row_number}: ${shown}`}
              align="start"
              triggerClassName={FINISH_TRIGGER}
              trigger={
                <>
                  <span className="min-w-0 truncate">{shown}</span>
                  <Icon
                    icon={ChevronDown}
                    size={14}
                    className="shrink-0 text-text-muted"
                  />
                </>
              }
              items={row.editions.map((choice) => {
                const label = variantLabel(choice.descriptor);
                return {
                  label,
                  checked: choice.edition_id === row.edition?.edition_id,
                  onSelect: () => {
                    if (choice.edition_id !== row.edition?.edition_id)
                      onFinish(choice.descriptor, label);
                  },
                };
              })}
            />
          )}
          {(fix || change) && (
            <Button
              ref={toggleRef}
              aria-label={resolverLabel}
              aria-expanded={open}
              onClick={onToggle}
            >
              {fix ? "Fix" : "Change"}
            </Button>
          )}
          {row.skipped ? (
            <Button
              variant="quiet"
              aria-label={`Restore row ${row.row_number}`}
              onClick={onRestore}
            >
              Restore
            </Button>
          ) : (
            <Button
              variant="quiet"
              aria-label={`Skip row ${row.row_number}`}
              onClick={onSkip}
            >
              Skip
            </Button>
          )}
          <span className="text-meta text-text-muted tabular-nums">
            Row {row.row_number}
          </span>
        </div>
        {open && (fix || change) && (
          <ImportRowResolver
            row={row}
            label={resolverLabel}
            onPick={onPick}
            onSkip={onSkip}
            onClose={onClose}
          />
        )}
      </div>
    </li>
  );
}
