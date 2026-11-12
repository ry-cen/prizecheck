import { WANT_LIST_SEGMENT } from "../decks/wantListModel";
import { OWNER_SUBPATHS } from "../owner/sections";

/** The signed-in shell tabs and their addresses. Tab roots stay mounted; detail screens exist only while shown. */
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
  /** Sub-addresses under `path` that open this page on one of its sections, for example /owner/rules for
   * Owner controls' Rules tab. The page reads its section with sectionAt. */
  sections?: readonly string[];
  /** Sub-addresses that show another view of this page under its own view switch (a tab list), not a page of their
   * own. Moving between the page's address and its views is a view switch, never a page entry. */
  views?: readonly string[];
  /** Sections that take exactly one further segment, for example `/trades/new/<Friend's Handle>` for the proposal
   * builder (Trading #284). The page reads `"<section>/<item>"` with sectionAt. */
  sectionItems?: readonly string[];
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
    // /collection/import: Collection Import (#226).
    sections: ["import"],
  },
  {
    id: "decks",
    path: "/decks",
    label: "Decks",
    views: [WANT_LIST_SEGMENT],
    param: true,
    itemSections: ["replace"],
  },
  {
    id: "catalog",
    path: "/catalog",
    label: "Catalog",
  },
  {
    // /loans/<Loan id>: one Loan (#252).
    id: "loans",
    path: "/loans",
    label: "Loans",
    param: true,
  },
  {
    // The Trades tab (Trading #269, #270, #276 and #298, prototype verdict variant A): /trades is the conversation
    // list, /trades/with/<trader id> and /trades/conversation/<conversation id> one conversation,
    // /trades/find Find trades, /trades/list My Trade List, /trades/new/<trader id> the proposal builder (#284; a
    // Handle address redirects to it, #299), /trades/trader/<trader id> a stranger's Trade List (#299),
    // /trades/<Trade id> one Trade and /trades/<Trade id>/counter a Counter to it (#278). A section name is
    // never a Trade id: Trade ids are UUIDs.
    id: "trades",
    path: "/trades",
    label: "Trades",
    sections: ["find", "list"],
    views: ["find", "list"],
    sectionItems: ["new", "with", "conversation", "trader"],
    param: true,
    itemSections: ["counter"],
  },
  {
    id: "reports",
    path: "/reports",
    label: "Card reports",
  },
  {
    id: "settings",
    path: "/settings",
    label: "Settings",
  },
  {
    id: "owner",
    path: "/owner",
    label: "Owner controls",
    sections: OWNER_SUBPATHS,
    views: OWNER_SUBPATHS,
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
/** Phone bottom tab bar (#252: Loans took the More slot; Card reports moved to the account sheet; Trading #269:
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
      (page.sectionItems ?? []).some((section) => {
        const prefix = `${page.path}/${section}/`;
        const item = path.slice(prefix.length);
        return path.startsWith(prefix) && item !== "" && !item.includes("/");
      }) ||
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

/** A tab root or one of its views (`views`). */
export function isViewAddress(path: string): boolean {
  return PAGES.some(
    (page) =>
      path === page.path ||
      (page.views ?? []).some((view) => path === `${page.path}/${view}`)
  );
}

/** Both addresses show the same page under its view switch. */
export function isViewSwitch(from: string, to: string): boolean {
  return (
    isViewAddress(from) &&
    isViewAddress(to) &&
    pageAt(from)?.id === pageAt(to)?.id
  );
}

/** A forward in-app move to a page of its own (pathnames, no query). */
export function opensPage(from: string, to: string): boolean {
  return (
    to !== from &&
    !PAGES.some((page) => page.path === to) &&
    !isViewSwitch(from, to)
  );
}
