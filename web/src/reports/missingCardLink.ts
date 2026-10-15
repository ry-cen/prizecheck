import type { MissingCardPrefill } from "../decks_generated";

/** The Missing cards report link, /reports?report=printing&name=…&number=…&set_id=…&set_name=…&note=…, opens Missing
 * cards on Report a card with the form filled in. Decklist Import's Not found lines link here (#213), with the values
 * the review chose (the API's MissingCardPrefill). Missing cards reads the link once and then removes it from the
 * address. */
const KIND = "report";
const FIELDS = {
  englishName: "name",
  number: "number",
  setId: "set_id",
  setName: "set_name",
  note: "note",
} as const;

export type MissingCardLink = Record<keyof typeof FIELDS, string>;

export function missingCardHref(report: MissingCardPrefill): string {
  const params = new URLSearchParams({ [KIND]: report.kind });
  const values: MissingCardLink = {
    englishName: report.english_name,
    number: report.collector_number ?? "",
    setId: report.set_id ?? "",
    setName: report.set_name ?? "",
    note: report.note,
  };
  for (const [field, param] of Object.entries(FIELDS))
    if (values[field as keyof MissingCardLink])
      params.set(param, values[field as keyof MissingCardLink]);
  return `/reports?${params}`;
}

/** The linked Missing Printing in the current address, or null without one. */
export function readMissingCardLink(): MissingCardLink | null {
  const params = new URLSearchParams(window.location.search);
  if (params.get(KIND) !== "printing") return null;
  return {
    englishName: params.get(FIELDS.englishName) ?? "",
    number: params.get(FIELDS.number) ?? "",
    setId: params.get(FIELDS.setId) ?? "",
    setName: params.get(FIELDS.setName) ?? "",
    note: params.get(FIELDS.note) ?? "",
  };
}

/** Removes the link from the address, keeping the path, other parameters and hash, so a reload opens Missing cards
 * as usual. */
export function clearMissingCardLink(): void {
  const params = new URLSearchParams(window.location.search);
  const names = [KIND, ...Object.values(FIELDS)];
  if (!names.some((name) => params.has(name))) return;
  for (const name of names) params.delete(name);
  const search = params.toString();
  window.history.replaceState(
    window.history.state,
    "",
    `${window.location.pathname}${search ? `?${search}` : ""}${window.location.hash}`
  );
}
