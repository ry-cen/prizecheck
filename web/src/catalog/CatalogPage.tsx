import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { FileText } from "lucide-react";
import type {
  BrowseEdition,
  BrowseFormat,
  BrowseKind,
  CatalogSet,
} from "../catalog_browse_generated";
import { EditionPrice } from "../EditionPrice";
import { MyMetadataReports } from "../MetadataReport";
import {
  clearMetadataReportLink,
  readMetadataReportLink,
} from "../metadataReportLink";
import { PageHeader } from "../shell/PageHeader";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { EditionTile } from "../ui/EditionTile";
import { SearchField } from "../ui/SearchField";
import { variantLabel } from "../ui/variantLabel";
import { TILE_PRICE } from "../workspace/Gallery";
import { OLD_BUTTONS, OLD_FIELDS, OLD_TEXT } from "../workspace/legacyContent";
import { useDebouncedValue } from "../workspace/useDebouncedValue";
import { CatalogCardPopup, type CardRequest } from "./CatalogCardPopup";
import { CatalogFilters } from "./CatalogFilters";
import {
  CATALOG_UNAVAILABLE,
  catalogLine,
  FORMAT_NAMES,
  searchHint,
} from "./catalogText";
import { useCatalogBrowse } from "./useCatalogBrowse";

const SEARCH_DELAY_MS = 250;
// The next page loads while the end of the gallery is still this far below the window.
const SCROLL_AHEAD = "0px 0px 800px 0px";

type Props = {
  /** False while the shell keeps the page mounted but hidden. */
  active: boolean;
  /** The app's last service message. */
  message: string;
};

/**
 * Catalog (#173, spec "Catalog"): an Edition gallery from the browse route, with one smart search box, one filter
 * row and the catalog's status line, and no sidebar. The gallery scrolls on: the next page loads as its end nears, or
 * when focus reaches its last tile. Tapping a tile opens the CardPopup (#174), which steps through the loaded tiles
 * with ‹ › or ← → (asking for the next page as it nears the end), and closing it returns focus to the tile of the
 * card it shows. My metadata reports opens from the page header, since nothing can sit below an endless gallery (the
 * spec's "at the foot of the page" predates infinite scroll). The page stays mounted while the collector is
 * elsewhere, so the search, filters, loaded rows and scroll are kept.
 */
export function CatalogPage({ active, message }: Props) {
  const [text, setText] = useState("");
  const q = useDebouncedValue(text.trim(), SEARCH_DELAY_MS);
  const [format, setFormat] = useState<BrowseFormat | null>(null);
  const [kind, setKind] = useState<BrowseKind | null>(null);
  const [set, setSet] = useState<CatalogSet | null>(null);
  const [owned, setOwned] = useState(false);
  const query = useMemo(
    () => ({ q, format, kind, set_id: set?.set_id ?? null, owned }),
    [q, format, kind, set, owned]
  );
  const browse = useCatalogBrowse(query, active);
  const [card, setCard] = useState<CardRequest | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  // The popup's place among the loaded tiles, found by Edition: the list can be replaced under it (a restart).
  const index = card?.editionId
    ? browse.editions.findIndex(
        (edition) => edition.edition_id === card.editionId
      )
    : -1;
  const [wantsNext, setWantsNext] = useState(false);
  const closedOn = useRef<string | null>(null);
  const [reportsKey, setReportsKey] = useState(0);
  const [reportsOpen, setReportsOpen] = useState(false);
  const reportsButton = useRef<HTMLButtonElement>(null);
  const hintId = useId();
  const sentinel = useRef<HTMLDivElement>(null);
  const { loadMore } = browse;
  const canLoad = browse.nextCursor !== null && !browse.errorMore;
  const editionsShown = browse.editions;

  const show = useCallback((edition: BrowseEdition) => {
    setCard({
      printingId: edition.printing_id,
      editionId: edition.edition_id,
      row: edition,
      report: null,
    });
  }, []);
  const stepTo = useCallback(
    (target: number) => {
      const edition = editionsShown[target];
      if (edition) show(edition);
    },
    [editionsShown, show]
  );
  const onPrevious = useCallback(() => stepTo(index - 1), [stepTo, index]);
  const onNext = useCallback(() => {
    if (index < editionsShown.length - 1) stepTo(index + 1);
    else if (canLoad) {
      // At the last loaded tile: step once the next page arrives.
      setWantsNext(true);
      loadMore();
    }
  }, [stepTo, index, editionsShown.length, canLoad, loadMore]);

  // Stepping near the end of the loaded tiles asks for the next page ahead of time.
  useEffect(() => {
    if (card && index >= 0 && index >= editionsShown.length - 5 && canLoad)
      loadMore();
  }, [card, index, editionsShown.length, canLoad, loadMore]);
  // The page asked for by › at the end arrived (or failed): step, or stop waiting.
  useEffect(() => {
    if (!wantsNext) return;
    if (!card || index < 0 || browse.errorMore) setWantsNext(false);
    else if (index < editionsShown.length - 1) {
      setWantsNext(false);
      stepTo(index + 1);
    }
  }, [wantsNext, card, index, editionsShown.length, browse.errorMore, stepTo]);
  // Closing the popup after stepping returns focus to the tile of the card it showed (the Dialog itself returns it
  // to the tile that opened it); the browser scrolls that tile into view.
  useEffect(() => {
    if (card || !closedOn.current) return;
    const id = closedOn.current;
    closedOn.current = null;
    const tile = document.querySelector<HTMLElement>(
      `[data-edition-id="${CSS.escape(id)}"]`
    );
    if (tile && tile !== document.activeElement) tile.focus();
  }, [card]);

  // Infinite scroll: a sentinel after the last tile asks for the next page as it nears the window. Observing again
  // after each page (the length changes) asks once more while the sentinel is still in reach.
  useEffect(() => {
    const element = sentinel.current;
    if (
      !element ||
      !canLoad ||
      !active ||
      typeof IntersectionObserver === "undefined"
    )
      return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMore();
      },
      { rootMargin: SCROLL_AHEAD }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [canLoad, active, browse.editions.length, browse.loadingMore, loadMore]);

  // The inspector's metadata report link (/catalog?printing=…&edition=…) opens the Printing's details with the
  // report form preset, whenever the page is shown with it; the link then leaves the address.
  useEffect(() => {
    if (!active) return;
    const link = readMetadataReportLink();
    clearMetadataReportLink();
    if (link) {
      opener.current = null;
      setCard({
        printingId: link.printingId,
        editionId: link.editionId,
        row: null,
        report: { kind: "metadata", editionId: link.editionId },
      });
    }
  }, [active]);

  const first = browse.first;
  const unavailable = first !== null && !first.available;
  return (
    <main className="mx-auto box-border flex w-full max-w-7xl min-w-0 flex-col gap-4 px-7 py-7 phone:px-4 phone:py-5">
      <PageHeader
        title="Catalog"
        actions={
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
        }
      />
      <div className="flex min-w-0 flex-col gap-1.5">
        <SearchField
          label="Search the catalog"
          placeholder="Card name, or set code and number"
          value={text}
          maxLength={120}
          aria-describedby={hintId}
          onChange={(event) => setText(event.target.value)}
        />
        <p id={hintId} className="m-0 text-meta text-text-muted">
          {searchHint(first?.search ?? null)}
        </p>
      </div>
      <CatalogFilters
        format={format}
        onFormat={setFormat}
        kind={kind}
        onKind={setKind}
        set={set}
        onSet={setSet}
        owned={owned}
        onOwned={setOwned}
      />
      <div role="status" className="flex flex-col gap-0.5 text-meta">
        {browse.notice && (
          <p className="m-0 font-medium text-text">{browse.notice}</p>
        )}
        <p className="m-0 text-text-muted">
          {unavailable
            ? CATALOG_UNAVAILABLE
            : first && first.printings !== null
              ? catalogLine(first.printings, first.last_success)
              : browse.loading
                ? "Loading the catalog…"
                : ""}
        </p>
      </div>
      {browse.error && !browse.errorMore && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 text-body text-danger"
        >
          <p className="m-0">{browse.error}</p>
          <Button onClick={browse.retry}>Retry</Button>
        </div>
      )}
      {first?.available && (
        <section aria-label="Catalog results" className="flex flex-col gap-3">
          <p className="m-0 text-meta text-text-subtle">
            {browse.editions.length === 0
              ? "No cards match this search."
              : `Showing ${browse.editions.length.toLocaleString()} of ${(first.matches ?? browse.editions.length).toLocaleString()} cards`}
          </p>
          {browse.editions.length > 0 && (
            <ul
              aria-busy={browse.loading}
              className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(var(--tile-medium),1fr))] gap-x-(--tile-gap-column) gap-y-(--tile-gap-row) p-0"
            >
              {browse.editions.map((edition, index) => (
                <li
                  key={edition.edition_id}
                  className="min-w-0"
                  // A keyboard path past the loaded rows: focus reaching the last tile loads the next page.
                  onFocus={
                    index === browse.editions.length - 1 && canLoad
                      ? loadMore
                      : undefined
                  }
                >
                  <CatalogTile
                    edition={edition}
                    format={format}
                    onOpen={(element) => {
                      opener.current = element;
                      show(edition);
                    }}
                  />
                </li>
              ))}
            </ul>
          )}
          {canLoad && (
            <div ref={sentinel} aria-hidden="true" className="h-px" />
          )}
          {browse.error && browse.errorMore && (
            <div
              role="alert"
              className="flex flex-wrap items-center gap-3 text-body text-danger"
            >
              <p className="m-0">{browse.error}</p>
              <Button onClick={browse.retry}>Retry</Button>
            </div>
          )}
          <p aria-live="polite" className="m-0 text-meta text-text-subtle">
            {browse.loadingMore
              ? "Loading more cards…"
              : browse.editions.length > 0 && browse.nextCursor === null
                ? `All ${browse.editions.length.toLocaleString()} cards shown`
                : ""}
          </p>
        </section>
      )}
      <Dialog
        open={reportsOpen}
        onClose={() => setReportsOpen(false)}
        title="My metadata reports"
        closeLabel="Close my metadata reports"
        size="wide"
        returnFocus={reportsButton}
      >
        <div
          className={`flex flex-col gap-2 text-body ${OLD_BUTTONS} ${OLD_FIELDS} ${OLD_TEXT} [&_label]:flex [&_label]:flex-col [&_label]:gap-1 [&_label]:text-meta [&_label]:text-text-muted [&_textarea]:box-border [&_textarea]:rounded-control [&_textarea]:border [&_textarea]:border-solid [&_textarea]:border-border-strong [&_textarea]:bg-bg [&_textarea]:p-2 [&_textarea]:font-sans [&_textarea]:text-control [&_textarea]:text-text [&_ul]:m-0 [&_ul]:list-none [&_ul]:p-0`}
        >
          <MyMetadataReports key={reportsKey} refreshKey={reportsKey} />
        </div>
      </Dialog>
      <CatalogCardPopup
        request={card}
        onClose={() => {
          closedOn.current = card?.editionId ?? null;
          setWantsNext(false);
          setCard(null);
        }}
        position={
          index >= 0 && first?.matches != null
            ? { index, total: Math.max(first.matches, editionsShown.length) }
            : null
        }
        canPrevious={index > 0}
        canNext={
          index >= 0 &&
          !wantsNext &&
          (index < editionsShown.length - 1 || canLoad)
        }
        onPrevious={onPrevious}
        onNext={onNext}
        onAdded={browse.noteAdded}
        onReported={() => setReportsKey((value) => value + 1)}
        returnFocus={opener}
      />
      <p role="alert" className="m-0 text-body text-danger">
        {message}
      </p>
    </main>
  );
}

/** One gallery tile: an EditionTile with its compact price and, under a format chip, a "?" for an unknown standing. */
function CatalogTile({
  edition,
  format,
  onOpen,
}: {
  edition: BrowseEdition;
  format: BrowseFormat | null;
  onOpen: (element: HTMLElement) => void;
}) {
  const priceId = useId();
  const unknown = format && edition.standing[format].status === "unknown";
  return (
    <EditionTile
      name={edition.name}
      setName={edition.set_name}
      setCode={edition.set_code}
      collectorNumber={edition.collector_number}
      variant={variantLabel(edition.descriptor)}
      imageUrl={edition.image_url}
      owned={edition.owned}
      flag={
        unknown
          ? { text: "?", label: `${FORMAT_NAMES[format]} legality unknown` }
          : null
      }
      price={
        <span className={TILE_PRICE}>
          <EditionPrice compact editionId={edition.edition_id} />
        </span>
      }
      priceId={priceId}
      aria-describedby={priceId}
      data-edition-id={edition.edition_id}
      onClick={(event) => onOpen(event.currentTarget)}
    />
  );
}
