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
    q: p.get("q") ?? "",
    format: FORMATS.find((o) => o.value === p.get("format"))?.value ?? null,
    kind: KINDS.find((o) => o.value === p.get("kind"))?.value ?? null,
    setId: /^[a-zA-Z0-9_-]+$/.test(p.get("set") ?? "") ? p.get("set") : null,
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
