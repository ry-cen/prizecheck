/**
 * Pages load on their first visit, so a phone opening a Published Deck link or Discover downloads only the shell,
 * the sign-in screens and that one page. Collection and the initial public page start loading at boot, alongside
 * the session read, so landing on them waits no longer than before. A lazily loaded module must not also be
 * imported statically from an eager module: the bundler would then keep it in the entry and the split does nothing.
 */
import { lazy } from "react";
import { COLLECTION_IMPORT_PATH } from "../collectionImport/route";
import { publicPageAt } from "../public/publicRoutes";
import { pageAt } from "./routes";

export const loadWorkspace = () => import("../workspace/Workspace");
export const loadDiscoverPage = () => import("../discover/DiscoverPage");
export const loadInvitePage = () => import("../public/InvitePage");
export const loadPublishedDeckPage = () =>
  import("../public/PublishedDeckPage");

export const Workspace = lazy(() =>
  loadWorkspace().then((m) => ({ default: m.Workspace }))
);
export const CollectionImportPage = lazy(() =>
  import("../collectionImport/CollectionImportPage").then((m) => ({
    default: m.CollectionImportPage,
  }))
);
export const DecksPage = lazy(() =>
  import("../decks/DecksPage").then((m) => ({ default: m.DecksPage }))
);
export const DeckBuilderPage = lazy(() =>
  import("../decks/DeckBuilderPage").then((m) => ({
    default: m.DeckBuilderPage,
  }))
);
export const ImportPage = lazy(() =>
  import("../decks/import/ImportPage").then((m) => ({ default: m.ImportPage }))
);
export const ReplaceListPage = lazy(() =>
  import("../decks/import/ReplaceListPage").then((m) => ({
    default: m.ReplaceListPage,
  }))
);
export const CatalogPage = lazy(() =>
  import("../catalog/CatalogPage").then((m) => ({ default: m.CatalogPage }))
);
export const LoansPage = lazy(() =>
  import("../loans/LoansPage").then((m) => ({ default: m.LoansPage }))
);
export const TradesPage = lazy(() =>
  import("../trades/TradesPage").then((m) => ({ default: m.TradesPage }))
);
export const MissingCardsPage = lazy(() =>
  import("../reports/MissingCardsPage").then((m) => ({
    default: m.MissingCardsPage,
  }))
);
export const OwnerControlsPage = lazy(() =>
  import("../owner/OwnerControlsPage").then((m) => ({
    default: m.OwnerControlsPage,
  }))
);
export const FriendTradeListPage = lazy(() =>
  import("../trades/FriendTradeListPage").then((m) => ({
    default: m.FriendTradeListPage,
  }))
);
export const DiscoverPage = lazy(() =>
  loadDiscoverPage().then((m) => ({ default: m.DiscoverPage }))
);
export const InvitePage = lazy(() =>
  loadInvitePage().then((m) => ({ default: m.InvitePage }))
);
export const PublishedDeckPage = lazy(() =>
  loadPublishedDeckPage().then((m) => ({ default: m.PublishedDeckPage }))
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
