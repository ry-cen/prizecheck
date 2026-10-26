// What one tray row shows, from the row (ids and a count) and whatever display data there is: this session's printings
// answer, else the cached number table when the printings route could not be reached. Pure.
import type { ScannerPrinting } from "../../scanner_generated";
import type { ChoiceOption } from "../../ui/Chip";
import { variantLabel } from "../../ui/variantLabel";
import type { TrayRow } from "../tray/store";
import { finishGone, GONE_FROM_CATALOG } from "./copy";
import type { CardFace } from "./offlineCards";

export type RowView = {
  name: string;
  /** "Paldea Evolved 185", or the set code and number from the cached table. */
  setLine: string;
  image: string | null;
  /** The active finishes, in the catalog's order; chips show only for two or more. */
  options: ChoiceOption[];
  /** The row's own finish while it is valid, else null (no chip selected). */
  selected: string | null;
  /** The one finish of a Printing that has only one, shown as text. */
  onlyFinish: string | null;
  /** The finish the row had, now gone from the catalog. */
  staleReason: string | null;
  /** The Printing itself is gone: no chips, Change card opens search. */
  printingGone: boolean;
  /** The row's current finish, for the peek line. */
  finish: string | null;
};

export function rowView(
  row: TrayRow,
  printing: ScannerPrinting | undefined,
  face: CardFace | null,
  opts: { offline: boolean; searchRow: boolean }
): RowView {
  if (!printing) {
    const gone = row.needs_pick && !opts.offline;
    return {
      name: face?.name ?? "Card",
      setLine: face
        ? [face.setCode, face.number].filter(Boolean).join(" ")
        : "",
      image: face?.image ?? null,
      options: [],
      selected: null,
      onlyFinish: null,
      staleReason: gone ? GONE_FROM_CATALOG : null,
      printingGone: gone,
      finish: null,
    };
  }
  const active = printing.editions.filter((e) => e.active);
  const options = active.map((e) => ({
    value: e.id,
    label: variantLabel(e.descriptor),
  }));
  const own = options.find((o) => o.value === row.edition_id);
  const selected = row.needs_pick ? null : (own?.value ?? null);
  const old = printing.editions.find((e) => e.id === row.edition_id);
  const gone = opts.searchRow;
  return {
    name: printing.name,
    setLine: `${printing.set_name} ${printing.collector_number}`,
    image: printing.low_image_url,
    options,
    selected,
    onlyFinish:
      options.length === 1 && !row.needs_pick ? options[0].label : null,
    staleReason: gone
      ? GONE_FROM_CATALOG
      : row.needs_pick
        ? finishGone(old ? variantLabel(old.descriptor) : "That finish")
        : null,
    printingGone: gone,
    finish: own?.label ?? null,
  };
}
