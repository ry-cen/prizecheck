/** The metadata report deep link, /catalog?printing=<id>&edition=<id>, opens the catalog's Printing detail with the
 * existing metadata report form preset to that Card Edition. The workspace inspector links here. The catalog reads
 * the link once and then removes it from the address. Following the link prefetches nothing. */
const PRINTING = "printing";
const EDITION = "edition";

export type MetadataReportLink = { printingId: string; editionId: string };

export function metadataReportHref(printingId: string, editionId: string) {
  return `/catalog?${new URLSearchParams({ [PRINTING]: printingId, [EDITION]: editionId })}`;
}

/** The linked Printing and Card Edition in the current address, or null unless both are present. */
export function readMetadataReportLink(): MetadataReportLink | null {
  const params = new URLSearchParams(window.location.search);
  const printingId = params.get(PRINTING);
  const editionId = params.get(EDITION);
  return printingId && editionId ? { printingId, editionId } : null;
}

/** Removes the link from the address, keeping the path, other parameters and hash, so a reload opens the plain
 * catalog search. */
export function clearMetadataReportLink(): void {
  const params = new URLSearchParams(window.location.search);
  if (!params.has(PRINTING) && !params.has(EDITION)) return;
  params.delete(PRINTING);
  params.delete(EDITION);
  const search = params.toString();
  window.history.replaceState(
    window.history.state,
    "",
    `${window.location.pathname}${search ? `?${search}` : ""}${window.location.hash}`
  );
}
