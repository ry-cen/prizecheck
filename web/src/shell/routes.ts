/** The signed-in pages inside the app shell, and the addresses that open them. Routing is client-side. */
export type PageId =
  | "collection"
  | "decks"
  | "catalog"
  | "reports"
  | "sign-ins"
  | "owner"
  | "old-collection";

export type PageDef = {
  id: PageId;
  path: string;
  /** The tab, menu and phone header label; legacy pages also use it as their h1. */
  label: string;
  /** The page stays mounted, hidden, while another page is shown, so it keeps its state and scroll.
   * Old pages that read their data only on mount remount on every visit until their redesign ticket
   * moves them onto the kit and turns this on. */
  keepMounted: boolean;
};

export const PAGES: readonly PageDef[] = [
  {
    id: "collection",
    path: "/collection",
    label: "Collection",
    keepMounted: true,
  },
  {
    id: "decks",
    path: "/decks",
    label: "Decks",
    keepMounted: false,
  },
  {
    id: "catalog",
    path: "/catalog",
    label: "Catalog",
    keepMounted: false,
  },
  {
    id: "reports",
    path: "/reports",
    label: "Missing cards",
    keepMounted: false,
  },
  {
    id: "sign-ins",
    path: "/settings/sign-ins",
    label: "Sign-ins",
    keepMounted: false,
  },
  {
    id: "owner",
    path: "/owner",
    label: "Owner controls",
    keepMounted: false,
  },
  // The old Collection page until its retirement (#164). No tab or menu links here.
  {
    id: "old-collection",
    path: "/old-collection",
    label: "Old Collection",
    keepMounted: false,
  },
];

/** Desktop header tabs. */
export const DESKTOP_TABS: readonly PageId[] = [
  "collection",
  "decks",
  "catalog",
  "reports",
];
/** Phone bottom tab bar, before More. */
export const PHONE_TABS: readonly PageId[] = ["collection", "decks", "catalog"];
/** The phone More sheet's pages (Owner controls for the owner only), before Sign out. */
export const MORE_PAGES: readonly PageId[] = ["reports", "sign-ins", "owner"];
/** The desktop avatar menu's pages (Owner controls for the owner only), before Sign out. */
export const ACCOUNT_PAGES: readonly PageId[] = ["sign-ins", "owner"];

/** Where signing in lands by default. */
export const DEFAULT_PATH = "/collection";

/** Old addresses for Collection: the bare origin, the retired /workspace and /locations. Anything else
 * is returned unchanged. */
export function canonicalPath(path: string): string {
  return path === "/" || path === "/workspace" || path === "/locations"
    ? DEFAULT_PATH
    : path;
}

export function pageAt(path: string): PageDef | undefined {
  return PAGES.find((page) => page.path === path);
}

export function pageDef(id: PageId): PageDef {
  return PAGES.find((page) => page.id === id)!;
}
