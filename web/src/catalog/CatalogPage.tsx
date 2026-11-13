import { catalogHref, parseCatalogView, type CatalogView } from "./catalogUrl";
import { AddQueueAccount, hasStoredAddQueue } from "./useStoredAddQueue";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { FileText } from "lucide-react";
import { MyMetadataReports } from "../MetadataReport";
import { readMetadataReportLink } from "../metadataReportLink";
import { PageHeader } from "../shell/PageHeader";
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
    options?: { replace?: boolean; preserveScroll?: boolean }
  ) => void;
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
export function CatalogPage({ active, message, address, onNavigate }: Props) {
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
  const changeView = (next: CatalogView) => {
    if (active)
      onNavigate(catalogHref(next), { replace: true, preserveScroll: true });
  };
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
    const report = readMetadataReportLink(next.href);
    if (report)
      setLink({
        printingId: report.printingId,
        editionId: report.editionId,
        row: null,
        report: { kind: "metadata", editionId: report.editionId },
      });
    const hasReportParams =
      next.searchParams.has("printing") || next.searchParams.has("edition");
    next.searchParams.delete("printing");
    next.searchParams.delete("edition");
    const normaliseMode =
      staleActiveMode || (view.mode === null && mode === "add");
    if (normaliseMode) next.searchParams.set("mode", mode);
    if (hasReportParams || normaliseMode)
      onNavigate(next.pathname + next.search + next.hash, {
        replace: true,
        preserveScroll: true,
      });
  }, [active, account, address]);

  return (
    <main className="mx-auto box-border flex w-full max-w-7xl min-w-0 flex-col gap-4 px-7 py-7 phone:px-4 phone:py-5">
      <PageHeader
        title="Catalog"
        actions={
          // Wraps on a phone, so the switch and the reports button never push the page sideways.
          <div className="flex flex-wrap items-center justify-end gap-2">
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
              aria-haspopup="dialog"
              onClick={() => {
                setReportsKey((value) => value + 1);
                setReportsOpen(true);
              }}
            >
              My metadata reports
            </Button>
          </div>
        }
      />
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
