import type { BrowseFormat, BrowseKind } from "../catalog_browse_generated";
import { FORMATS, KINDS, type CatalogMode } from "./catalogText";
export type CatalogView = {
  q: string;
  format: BrowseFormat | null;
  kind: BrowseKind | null;
  setId: string | null;
  owned: boolean;
  mode: CatalogMode | null;
};
export function parseCatalogView(address: string): CatalogView {
  const p = new URL(address, "http://localhost").searchParams;
  return {
    // catalog_browse.py: q max_length=120, set_id max_length=80.
    q: Array.from(p.get("q") ?? "").length <= 120 ? (p.get("q") ?? "") : "",
    format: FORMATS.find((o) => o.value === p.get("format"))?.value ?? null,
    kind: KINDS.find((o) => o.value === p.get("kind"))?.value ?? null,
    // catalog.py SOURCE_ID_PATTERN, with the browse endpoint's narrower length.
    setId:
      /^[A-Za-z0-9_.!%~-]{1,80}$/.test(p.get("set") ?? "") &&
      /[^.]/.test(p.get("set") ?? "")
        ? p.get("set")
        : null,
    owned: p.get("owned") === "1",
    mode:
      p.get("mode") === "add"
        ? "add"
        : p.get("mode") === "browse"
          ? "browse"
          : null,
  };
}
export function catalogHref(view: CatalogView): string {
  const p = new URLSearchParams();
  if (view.q) p.set("q", view.q);
  if (view.format) p.set("format", view.format);
  if (view.kind) p.set("kind", view.kind);
  if (view.setId) p.set("set", view.setId);
  if (view.owned) p.set("owned", "1");
  if (view.mode) p.set("mode", view.mode);
  return "/catalog" + (p.size ? "?" + p : "");
}

/** The open card the Catalog address names: a Card Printing and, when valid, the Card Edition shown. */
export type CatalogCard = { printingId: string; editionId: string | null };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isCatalogId = (value: string | null): value is string =>
  value !== null && UUID.test(value);
/** The `card` (and `edition`) parameters, or null unless `card` is a well-formed id. */
export function parseCatalogCard(address: string): CatalogCard | null {
  const p = new URL(address, "http://localhost").searchParams;
  const printingId = p.get("card");
  if (!isCatalogId(printingId)) return null;
  const editionId = p.get("edition");
  return { printingId, editionId: isCatalogId(editionId) ? editionId : null };
}
/** The Catalog address for a view with a card open. Opens `catalogHref` unchanged: only this adds the card. */
export function catalogCardHref(
  view: CatalogView,
  card: CatalogCard | null
): string {
  const href = catalogHref(view);
  if (!card) return href;
  const p = new URLSearchParams({ card: card.printingId });
  if (card.editionId) p.set("edition", card.editionId);
  return href + (href.includes("?") ? "&" : "?") + p;
}
