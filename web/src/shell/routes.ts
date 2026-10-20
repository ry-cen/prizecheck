import { OWNER_SUBPATHS } from "../owner/sections";

/** The signed-in pages inside the app shell, and the addresses that open them. Routing is client-side. */
export type PageId =
  | "collection"
  | "decks"
  | "catalog"
  | "loans"
  | "trades"
  | "reports"
  | "settings"
  | "owner";

export type PageDef = {
  id: PageId;
  path: string;
  /** The tab, menu and phone header label. */
  label: string;
  /** The page stays mounted, hidden, while another page is shown, so it keeps its state and scroll.
   * Old pages that read their data only on mount remount on every visit until their redesign ticket
   * moves them onto the kit and turns this on. */
  keepMounted: boolean;
  /** Sub-addresses under `path` that open this page on one of its sections, for example /owner/rules for
   * Owner controls' Rules tab. The page reads its section with sectionAt. */
  sections?: readonly string[];
  /** Any one further segment opens this page on that item, for example /decks/<Deck id> for a Deck in the deck
   * builder (#176). The page reads the item with sectionAt. */
  param?: boolean;
  /** With `param`: sub-addresses under an item, for example /decks/<Deck id>/replace for Replace list… (#215). The
   * page reads "<item>/<sub-address>" with sectionAt. */
  itemSections?: readonly string[];
};

export const PAGES: readonly PageDef[] = [
  {
    id: "collection",
    path: "/collection",
    label: "Collection",
    keepMounted: true,
    // /collection/import: Collection Import (#226).
    sections: ["import"],
  },
  {
    id: "decks",
    path: "/decks",
    label: "Decks",
    keepMounted: false,
    param: true,
    itemSections: ["replace"],
  },
  {
    id: "catalog",
    path: "/catalog",
    label: "Catalog",
    keepMounted: true,
  },
  {
    // /loans/<Loan id>: one Loan (#252).
    id: "loans",
    path: "/loans",
    label: "Loans",
    keepMounted: false,
    param: true,
  },
  {
    // The Trades tab (Trading #269 and #270, prototype verdict variant A): /trades is the Trades list, /trades/list My
    // Trade List, /trades/draft the Trade Proposal draft and /trades/<Trade id> one Trade. Find trades (/trades/find)
    // arrives with discovery (#276). A section name is never a Trade id: Trade ids are UUIDs.
    id: "trades",
    path: "/trades",
    label: "Trades",
    keepMounted: false,
    sections: ["list", "draft"],
    param: true,
  },
  {
    id: "reports",
    path: "/reports",
    label: "Missing cards",
    keepMounted: true,
  },
  {
    id: "settings",
    path: "/settings",
    label: "Settings",
    keepMounted: false,
  },
  {
    id: "owner",
    path: "/owner",
    label: "Owner controls",
    keepMounted: false,
    sections: OWNER_SUBPATHS,
  },
];

/** Desktop header tabs. */
export const DESKTOP_TABS: readonly PageId[] = [
  "collection",
  "decks",
  "catalog",
  "loans",
  "trades",
  "reports",
];
/** Phone bottom tab bar (#252: Loans took the More slot; Missing cards moved to the account sheet; Trading #269:
 * Trades is the fifth). */
export const PHONE_TABS: readonly PageId[] = [
  "collection",
  "decks",
  "catalog",
  "loans",
  "trades",
];
/** The desktop avatar menu's pages (Owner controls for the owner only), before Sign out. */
export const ACCOUNT_PAGES: readonly PageId[] = ["settings", "owner"];

/** Where signing in lands by default. */
export const DEFAULT_PATH = "/collection";

/** Old addresses: for Collection the bare origin, the retired /workspace, /locations and /old-collection; for Settings
 * (#207) the retired Sign-ins page's /settings/sign-ins, where the auth gateway still returns link starts with a
 * failure in the query (auth/src/signIns.ts). Anything else is returned unchanged. */
export function canonicalPath(path: string): string {
  if (path === "/settings/sign-ins") return "/settings";
  return path === "/" ||
    path === "/workspace" ||
    path === "/locations" ||
    path === "/old-collection"
    ? DEFAULT_PATH
    : path;
}

export function pageAt(path: string): PageDef | undefined {
  return PAGES.find(
    (page) =>
      page.path === path ||
      (page.sections ?? []).some(
        (section) => path === `${page.path}/${section}`
      ) ||
      (page.param === true &&
        path.startsWith(`${page.path}/`) &&
        isItemPath(page, path.slice(page.path.length + 1)))
  );
}

/** "<item>", or "<item>/<one of the page's itemSections>". */
function isItemPath(page: PageDef, rest: string): boolean {
  const [item, sub, ...more] = rest.split("/");
  return (
    item !== "" &&
    more.length === 0 &&
    (sub === undefined || (page.itemSections ?? []).includes(sub))
  );
}

/** The section a sub-address names (/owner/rules is "rules", /decks/<id> is the Deck id), or null for a page's
 * own address. */
export function sectionAt(path: string): string | null {
  const page = pageAt(path);
  return page && path !== page.path ? path.slice(page.path.length + 1) : null;
}

export function pageDef(id: PageId): PageDef {
  return PAGES.find((page) => page.id === id)!;
}
