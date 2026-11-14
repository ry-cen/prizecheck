import {
  catalogCardHref,
  catalogHref,
  isCatalogId,
  parseCatalogCard,
  parseCatalogView,
  type CatalogCard,
  type CatalogView,
} from "./catalogUrl";
import { AddQueueAccount, hasStoredAddQueue } from "./useStoredAddQueue";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { FileText } from "lucide-react";
import { MyMetadataReports } from "../MetadataReport";
import { readMetadataReportLink } from "../metadataReportLink";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { Segmented } from "../ui/Segmented";
import { OLD_BUTTONS, OLD_FIELDS, OLD_TEXT } from "../workspace/legacyContent";
import { CatalogGallery } from "./CatalogGallery";
import type { CardRequest } from "./CatalogCardPopup";
import { MODES, type CatalogMode } from "./catalogText";

type Props = {
  /** False while the shell keeps the page mounted but hidden. */
  active: boolean;
  address: string;
  onNavigate: (
    address: string,
    options?: {
      replace?: boolean;
      preserveScroll?: boolean;
      overlay?: boolean;
    }
  ) => void;
  /** Closes the open card: back one entry when it was pushed, else replaces the address with this one. */
  onCloseCard: (address: string) => void;
  /** The app's last service message. */
  message: string;
};

/**
 * Catalog (#173, spec "Catalog"): the Edition gallery (catalog/CatalogGallery) with its card popup (#174), and no
 * sidebar. The page header holds the Browse / Add to a Location switch (#175): Add mode puts the gallery's add bar
 * on top and a quick + on every tile, and the queue is kept when the collector switches back to Browse. My metadata
 * reports opens from the page header, since nothing can sit below an endless gallery (the spec's "at the foot of the
 * page" predates infinite scroll). The page stays mounted while the collector is elsewhere, so the mode, search,
 * filters, queue, loaded rows and scroll are kept.
 */
export function CatalogPage({
  active,
  message,
  address,
  onNavigate,
  onCloseCard,
}: Props) {
  const account = useContext(AddQueueAccount);
  const owner = useRef(account);
  const lastAddress = useRef(address);
  // Observe every account transition even while hidden (including A → B → A).
  // A hidden page's kept mode belongs to its old account. A newly supplied
  // active address still takes precedence, including an explicit mode.
  const staleActiveMode =
    owner.current !== account && active && lastAddress.current === address;
  if (owner.current !== account) {
    owner.current = account;
    lastAddress.current = "/catalog";
  }
  if (active && !staleActiveMode) lastAddress.current = address;
  const view = parseCatalogView(lastAddress.current);
  const mode =
    view.mode ?? (hasStoredAddQueue(account, "page") ? "add" : "browse");
  const routeCard = parseCatalogCard(lastAddress.current);
  // A view change while a card is open (the unknown-set reset of a shared link) keeps the card in the address.
  const changeView = (next: CatalogView) => {
    if (active)
      onNavigate(catalogCardHref(next, routeCard), {
        replace: true,
        preserveScroll: true,
        overlay: true,
      });
  };
  // The open card is written to the address, only while this page is the one shown.
  const activeRef = useRef(active);
  activeRef.current = active;
  const latest = useRef({ view, address: lastAddress.current });
  latest.current = { view, address: lastAddress.current };
  const onCardRoute = useCallback(
    (card: CatalogCard | null, how: "open" | "replace" | "close") => {
      if (!activeRef.current) return;
      const { view, address } = latest.current;
      if (how === "close") {
        onCloseCard(catalogHref(view));
        return;
      }
      const to = catalogCardHref(view, card);
      if (to === address) return;
      onNavigate(to, {
        ...(how === "replace" ? { replace: true } : {}),
        overlay: true,
        preserveScroll: true,
      });
    },
    [onNavigate, onCloseCard]
  );
  const setMode = (mode: CatalogMode) => changeView({ ...view, mode });
  const [link, setLink] = useState<CardRequest | null>(null);
  const [reportsKey, setReportsKey] = useState(0);
  const [reportsOpen, setReportsOpen] = useState(false);
  const reportsButton = useRef<HTMLButtonElement>(null);
  const linkOpened = useCallback(() => setLink(null), []);
  const reported = useCallback(() => setReportsKey((value) => value + 1), []);

  // Consume one-use report parameters from the supplied address before making
  // any URL replacement. The shell must see the consumed address too, otherwise
  // its remembered Catalog tab would reopen the report on the next visit.
  useEffect(() => {
    if (!active) return;
    const next = new URL(lastAddress.current, window.location.origin);
    const params = next.searchParams;
    let changed = false;
    // The inspector's report link: `printing` and `edition` open the card with the Edition's report form.
    const printing = params.get("printing");
    const link = readMetadataReportLink(next.href);
    const report =
      link && isCatalogId(link.printingId) && isCatalogId(link.editionId)
        ? link
        : null;
    if (report)
      setLink({
        printingId: report.printingId,
        editionId: report.editionId,
        row: null,
        report: { kind: "metadata", editionId: report.editionId },
      });
    let cardId = params.get("card");
    let editionId = params.get("edition");
    if (printing !== null) {
      params.delete("printing");
      changed = true;
      // A `printing` alone is no link: it is only read beside an `edition`.
      if (isCatalogId(printing) && params.has("edition")) {
        cardId = printing;
        if (!report) editionId = null;
      }
    }
    // `edition` only means something beside a well-formed `card`.
    if (!isCatalogId(cardId)) {
      cardId = null;
      editionId = null;
    } else if (!isCatalogId(editionId)) editionId = null;
    if (cardId !== params.get("card") || editionId !== params.get("edition")) {
      params.delete("card");
      params.delete("edition");
      changed = true;
    }
    const normaliseMode =
      staleActiveMode || (view.mode === null && mode === "add");
    if (normaliseMode) {
      params.set("mode", mode);
      changed = true;
    }
    if (changed) {
      // Order as catalogCardHref writes it: the view, then the card.
      params.delete("card");
      params.delete("edition");
      if (cardId) params.set("card", cardId);
      if (cardId && editionId) params.set("edition", editionId);
      onNavigate(next.pathname + next.search + next.hash, {
        replace: true,
        preserveScroll: true,
        overlay: true,
      });
    }
  }, [active, account, address]);

  return (
    <main className="mx-auto box-border flex w-full max-w-7xl min-w-0 flex-col gap-4 px-7 py-7 phone:px-4 phone:py-5">
      <div className="mb-5 flex flex-wrap items-center gap-4 phone:mb-0 phone:gap-2">
        <h1 className="m-0 text-display font-semibold phone:text-heading">
          Catalog
        </h1>
        <div className="ml-auto flex flex-wrap items-center gap-2 phone:contents">
          <div className="flex flex-wrap items-center justify-end gap-2 phone:contents phone:[&>div]:order-last phone:[&>div]:basis-full">
            <Segmented
              mode="choice"
              label="Catalog mode"
              options={MODES}
              value={mode}
              onChange={setMode}
            />
            <Button
              ref={reportsButton}
              variant="quiet"
              icon={FileText}
              className="phone:ml-auto"
              aria-haspopup="dialog"
              onClick={() => {
                setReportsKey((value) => value + 1);
                setReportsOpen(true);
              }}
            >
              My metadata reports
            </Button>
          </div>
        </div>
      </div>
      <CatalogGallery
        active={active}
        view={view}
        onViewChange={changeView}
        adding={mode === "add"}
        fixedTarget={null}
        undoToast
        stick="page"
        link={link}
        onLinkOpened={linkOpened}
        onReported={reported}
        routeCard={routeCard}
        onCardRoute={onCardRoute}
      />
      <Dialog
        open={reportsOpen}
        onClose={() => setReportsOpen(false)}
        title="My metadata reports"
        closeLabel="Close my metadata reports"
        size="wide"
        returnFocus={reportsButton}
      >
        <div
          className={`flex flex-col gap-2 text-body ${OLD_BUTTONS} ${OLD_FIELDS} ${OLD_TEXT} [&_h2]:text-[length:1.5em] [&_h2]:font-bold [&_h3]:text-[length:1.17em] [&_h3]:font-bold [&_h4]:font-bold [&_label]:flex [&_label]:flex-col [&_label]:gap-1 [&_label]:text-meta [&_label]:text-text-muted [&_textarea]:box-border [&_textarea]:rounded-control [&_textarea]:border [&_textarea]:border-solid [&_textarea]:border-control-outline [&_textarea]:bg-bg [&_textarea]:p-2 [&_textarea]:font-sans [&_textarea]:text-control [&_textarea]:text-text [&_ul]:m-0 [&_ul]:list-none [&_ul]:p-0`}
        >
          <MyMetadataReports key={reportsKey} refreshKey={reportsKey} />
        </div>
      </Dialog>
      <p role="alert" className="m-0 text-body text-danger">
        {message}
      </p>
    </main>
  );
}
