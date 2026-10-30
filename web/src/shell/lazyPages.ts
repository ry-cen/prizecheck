/**
 * Pages load on their first visit, so a phone opening a Published Deck link or Discover downloads only the shell,
 * the sign-in screens and that one page. Collection and the initial public page start loading at boot, alongside
 * the session read, so landing on them waits no longer than before. A lazily loaded module must not also be
 * imported statically from an eager module: the bundler would then keep it in the entry and the split does nothing.
 *
 * Signed in, the shell's pages load in the background once the browser is idle (preloadShellPages). Each tab
 * mounts hidden after its code arrives, so its first data read starts before the tab is opened.
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
import { pageAt, type PageId } from "./routes";

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
  ["collection", Workspace],
  ["decks", DecksPage],
  ["catalog", CatalogPage],
  ["loans", LoansPage],
  ["trades", TradesPage],
  ["reports", MissingCardsPage],
] as const;

/** Load code, idle, mount one root, and wait for its first read before warming the next root. */
export function preloadShellPages(
  owner: boolean,
  onReady: (id: PageId) => Promise<void>
): () => void {
  if (
    (navigator as Navigator & { connection?: { saveData?: boolean } })
      .connection?.saveData
  )
    return () => {};
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let idleId: number | undefined;
  let wake: (() => void) | undefined;
  const idle = () =>
    new Promise<void>((resolve) => {
      wake = resolve;
      if (typeof window.requestIdleCallback === "function")
        idleId = window.requestIdleCallback(() => resolve());
      else timer = setTimeout(resolve, 200);
    });
  void (async () => {
    const pages: Array<
      readonly [PageId, { preload: () => Promise<unknown> } | null]
    > = [
      ...SHELL_PAGES,
      ["settings", null],
      ...(owner ? [["owner", OwnerControlsPage] as const] : []),
    ];
    for (const [id, code] of pages) {
      await idle();
      if (cancelled) return;
      await code?.preload().catch(() => undefined);
      if (cancelled) return;
      await idle();
      if (cancelled) return;
      await Promise.race([
        onReady(id),
        new Promise<void>((resolve) => {
          wake = resolve;
          timer = setTimeout(resolve, 5000);
        }),
      ]);
      clearTimeout(timer);
      if (cancelled) return;
    }
    await idle();
    if (!cancelled) void DeckBuilderPage.preload().catch(() => undefined);
  })();
  return () => {
    cancelled = true;
    clearTimeout(timer);
    if (idleId !== undefined) window.cancelIdleCallback(idleId);
    wake?.();
  };
}
