import { emptyCollectionQuery, type CollectionQuery } from "./collection";
import { emptyQuery, type Query } from "./catalog";
export type View = {
  query: Query;
  edition: string;
  home: boolean;
  section?: "catalog" | "collection";
  collection?: CollectionQuery;
};
export function parseView(hash: string): View {
  const p = new URLSearchParams(
    hash.startsWith("#riftbound:") ? hash.slice(11) : ""
  );
  const raw = Number(p.get("page"));
  const collectionPage = Number(p.get("collectionPage"));
  return {
    ...(p.has("section")
      ? {
          section:
            p.get("section") === "collection"
              ? ("collection" as const)
              : ("catalog" as const),
          collection: {
            ...emptyCollectionQuery,
            location: p.get("location") ?? "all",
            search: p.get("collectionSearch") ?? "",
            page:
              Number.isSafeInteger(collectionPage) && collectionPage > 0
                ? collectionPage
                : 1,
          },
        }
      : {}),
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
      ...(view.section
        ? {
            section: view.section,
            location: view.collection?.location ?? "all",
            collectionSearch: view.collection?.search ?? "",
            collectionPage: String(view.collection?.page ?? 1),
          }
        : {}),
      ...view.query,
      page: String(view.query.page),
      edition: view.edition,
      view: view.home ? "home" : "catalog",
    })
  );
}
/** What the entry supplies: a view asking for anything else falls back to the Catalog. */
export type Supports = { facets?: boolean; collection?: boolean };
export function supportedView(view: View, supports: Supports): View {
  let next = view;
  if (supports.collection === false && next.section === "collection") {
    const { section: _s, collection: _c, ...rest } = next;
    next = rest;
  }
  return supports.facets === false && (next.query.domain || next.query.type)
    ? { ...next, query: { ...next.query, domain: "", type: "" } }
    : next;
}
