import { emptyQuery, type Query } from "./catalog";
export type View = { query: Query; edition: string; home: boolean };
export function parseView(hash: string): View {
  const p = new URLSearchParams(
    hash.startsWith("#riftbound:") ? hash.slice(11) : ""
  );
  const raw = Number(p.get("page"));
  return {
    query: {
      ...emptyQuery,
      search: p.get("search") ?? "",
      set: p.get("set") ?? "",
      domain: p.get("domain") ?? "",
      type: p.get("type") ?? "",
      page: Number.isSafeInteger(raw) && raw > 0 ? raw : 1,
    },
    edition: p.get("edition") ?? "",
    home: p.get("view") === "home",
  };
}
export function viewHash(view: View): string {
  return (
    "#riftbound:" +
    new URLSearchParams({
      ...view.query,
      page: String(view.query.page),
      edition: view.edition,
      view: view.home ? "home" : "catalog",
    })
  );
}
