/**
 * Pages load on their first visit, so a phone opening a Published Deck link or Discover downloads only the shell,
 * the sign-in screens and that one page. Collection and the initial public page start loading at boot, alongside
 * the session read, so landing on them waits no longer than before. A lazily loaded module must not also be
 * imported statically from an eager module: the bundler would then keep it in the entry and the split does nothing.
 *
 * Signed in, the shell's pages then load in the background once the browser is idle (preloadShellPages), so a tab
 * opened for the first time shows its page at once instead of an empty page area while its code downloads.
 */
import {
  createElement,
  lazy,
  useState,
  type ComponentType,
  type ReactElement,
} from "react";
import { COLLECTION_IMPORT_PATH } from "../collectionImport/route";
import { publicPageAt } from "../public/publicRoutes";
import { pageAt } from "./routes";

type PreloadablePage<P> = ((props: P) => ReactElement) & {
  preload: () => Promise<unknown>;
};

/**
 * A lazy page that can start loading before it is shown. Once its code has arrived, a newly mounted page renders it
 * in the same pass, so no empty frame of the Suspense fallback shows between the tab press and the page. Each
 * mount keeps the component it started with: swapping the lazy wrapper for the loaded one later would remount the
 * page and lose its state.
 */
function lazyPage<M, P extends object>(
  load: () => Promise<M>,
  pick: (module: M) => ComponentType<P>
): PreloadablePage<P> {
  let loaded: ComponentType<P> | null = null;
  const preload = () =>
    load().then((module) => {
      loaded = pick(module);
      return loaded;
    });
  const Lazy = lazy(() => preload().then((page) => ({ default: page })));
  function Page(props: P) {
    const [Shown] = useState<ComponentType<P>>(() => loaded ?? Lazy);
    return createElement(Shown, props);
  }
  return Object.assign(Page, { preload });
}

export const loadWorkspace = () => import("../workspace/Workspace");
export const loadDiscoverPage = () => import("../discover/DiscoverPage");
export const loadInvitePage = () => import("../public/InvitePage");
export const loadPublishedDeckPage = () =>
  import("../public/PublishedDeckPage");

export const Workspace = lazyPage(loadWorkspace, (m) => m.Workspace);
export const CollectionImportPage = lazyPage(
  () => import("../collectionImport/CollectionImportPage"),
  (m) => m.CollectionImportPage
);
export const DecksPage = lazyPage(
  () => import("../decks/DecksPage"),
  (m) => m.DecksPage
);
export const DeckBuilderPage = lazyPage(
  () => import("../decks/DeckBuilderPage"),
  (m) => m.DeckBuilderPage
);
export const ImportPage = lazyPage(
  () => import("../decks/import/ImportPage"),
  (m) => m.ImportPage
);
export const ReplaceListPage = lazyPage(
  () => import("../decks/import/ReplaceListPage"),
  (m) => m.ReplaceListPage
);
export const CatalogPage = lazyPage(
  () => import("../catalog/CatalogPage"),
  (m) => m.CatalogPage
);
export const LoansPage = lazyPage(
  () => import("../loans/LoansPage"),
  (m) => m.LoansPage
);
export const TradesPage = lazyPage(
  () => import("../trades/TradesPage"),
  (m) => m.TradesPage
);
export const MissingCardsPage = lazyPage(
  () => import("../reports/MissingCardsPage"),
  (m) => m.MissingCardsPage
);
export const OwnerControlsPage = lazyPage(
  () => import("../owner/OwnerControlsPage"),
  (m) => m.OwnerControlsPage
);
export const FriendTradeListPage = lazyPage(
  () => import("../trades/FriendTradeListPage"),
  (m) => m.FriendTradeListPage
);
export const DiscoverPage = lazyPage(loadDiscoverPage, (m) => m.DiscoverPage);
export const InvitePage = lazyPage(loadInvitePage, (m) => m.InvitePage);
export const PublishedDeckPage = lazyPage(
  loadPublishedDeckPage,
  (m) => m.PublishedDeckPage
);

/** Starts the first page's code for the canonical address; a failed preload is left for the page's own boundary. */
export function preloadInitialPage(path: string): void {
  if (pageAt(path)?.id === "collection" && path !== COLLECTION_IMPORT_PATH) {
    loadWorkspace().catch(() => undefined);
    return;
  }
  const page = publicPageAt(path);
  if (!page) return;
  const load =
    page.kind === "discover"
      ? loadDiscoverPage
      : page.kind === "invite"
        ? loadInvitePage
        : loadPublishedDeckPage;
  load().catch(() => undefined);
}

/** Shell pages, in the order they are likely opened, for preloadShellPages. */
const SHELL_PAGES = [
  Workspace,
  DecksPage,
  CatalogPage,
  LoansPage,
  TradesPage,
  MissingCardsPage,
  DeckBuilderPage,
];

/**
 * Starts the signed-in shell's page code once the browser is idle, one page after another so the shown page's own
 * reads go first. Owner controls loads only for the owner. A failed preload is left for the page's own boundary.
 */
export function preloadShellPages(owner: boolean): () => void {
  const pages = owner ? [...SHELL_PAGES, OwnerControlsPage] : SHELL_PAGES;
  let cancelled = false;
  const idle = (next: () => void) => {
    if (typeof window.requestIdleCallback === "function")
      window.requestIdleCallback(next, { timeout: 2000 });
    else window.setTimeout(next, 200);
  };
  const step = (index: number) => {
    if (cancelled || index >= pages.length) return;
    pages[index]
      .preload()
      .catch(() => undefined)
      .finally(() => idle(() => step(index + 1)));
  };
  idle(() => step(0));
  return () => {
    cancelled = true;
  };
}
