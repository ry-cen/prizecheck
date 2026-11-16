import { emptyCollectionQuery, type CollectionQuery } from "./collection";
import { emptyQuery, type Query } from "./catalog";
export type View = {
  query: Query;
  edition: string;
  home: boolean;
  section?: "catalog" | "collection" | "decks";
  deck?: string;
  deckTab?: string;
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
            p.get("section") === "decks"
              ? ("decks" as const)
              : p.get("section") === "collection"
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
    ...(p.get("section") === "decks"
      ? {
          deck: p.get("deck") ?? "",
          deckTab: p.get("deckTab") === "library" ? "library" : "deck",
        }
      : {}),
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
            ...(view.section === "decks"
              ? { deck: view.deck ?? "", deckTab: view.deckTab ?? "deck" }
              : {}),
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
