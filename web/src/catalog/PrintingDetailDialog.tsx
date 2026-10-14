import { useEffect, useRef, useState, type RefObject } from "react";
import { getPrinting, type PrintingView } from "../generated";
import { EditionPrice } from "../EditionPrice";
import { MetadataReport } from "../MetadataReport";
import { MissingCardReports } from "../MissingCardReports";
import { Dialog } from "../ui/Dialog";
import { variantLabel } from "../ui/variantLabel";
import { OLD_BUTTONS, OLD_FIELDS, OLD_TEXT } from "../workspace/legacyContent";

export type DetailRequest = {
  printingId: string;
  /** The Edition whose metadata report opens preset (the inspector's report link), or null. */
  reportEditionId: string | null;
  /** Open the metadata report form at once (the report link). */
  report: boolean;
  /** The set's printed code, when opened from a tile; the report link has none, so its TCGdex set ID shows. */
  setCode?: string;
};

function CardArt({ url, name }: { url: string | null; name: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  if (!url || failed)
    return (
      <div
        role="img"
        aria-label={`Artwork unavailable for ${name}`}
        className="box-border flex aspect-(--tile-aspect) w-44 shrink-0 items-center justify-center rounded-card bg-surface-raised p-2 text-center text-caption text-text-muted"
      >
        Artwork unavailable
      </div>
    );
  return (
    <img
      src={url}
      alt={`${name} card art`}
      onError={() => setFailed(true)}
      className="block aspect-(--tile-aspect) w-44 shrink-0 rounded-card object-contain"
    />
  );
}

/**
 * A Card Printing's details, opened from a Catalog tile (#173): the art, set and number, Card Identity, source,
 * each Card Edition with its price, and today's report flows (a missing Edition, Printing metadata, an Edition's
 * metadata). It keeps the old Catalog detail's content on the kit's Dialog until the CardPopup (#174) replaces it; the
 * report forms are the old shared components, styled from here (workspace/legacyContent).
 */
export function PrintingDetailDialog({
  request,
  onClose,
  onReported,
  returnFocus,
}: {
  request: DetailRequest | null;
  onClose: () => void;
  /** A metadata report was sent: My metadata reports reads again. */
  onReported: () => void;
  returnFocus?: RefObject<HTMLElement | null>;
}) {
  const [printing, setPrinting] = useState<PrintingView | null>(null);
  const [failed, setFailed] = useState(false);
  const [missingOpen, setMissingOpen] = useState(false);
  const [metadata, setMetadata] = useState<{ editionId: string | null } | null>(
    null
  );
  const reportRef = useRef<HTMLDivElement>(null);
  const focusReport = useRef(false);

  useEffect(() => {
    setPrinting(null);
    setFailed(false);
    setMissingOpen(false);
    setMetadata(null);
    if (!request) return;
    let cancelled = false;
    getPrinting(request.printingId)
      .then((response) => {
        if (cancelled) return;
        const found = response.printing;
        setPrinting(found);
        if (request.report) {
          // Preset to the linked Card Edition; an Edition this Printing doesn't have opens the Printing report.
          setMetadata({
            editionId: found.editions.some(
              (edition) => edition.id === request.reportEditionId
            )
              ? request.reportEditionId
              : null,
          });
          focusReport.current = true;
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [request]);

  // The linked report form takes focus once it is shown, so it is in view and keyboard-ready.
  useEffect(() => {
    if (!focusReport.current || !metadata) return;
    focusReport.current = false;
    reportRef.current?.querySelector<HTMLElement>("select")?.focus();
  }, [metadata]);

  return (
    <Dialog
      open={request !== null}
      onClose={onClose}
      title={printing?.name ?? "Card details"}
      closeLabel="Close card details"
      size="wide"
      returnFocus={returnFocus}
    >
      {failed ? (
        <p role="alert" className="m-0 text-body text-danger">
          Printing details are unavailable. Please retry.
        </p>
      ) : !printing ? (
        <p role="status" className="m-0 text-body text-text-muted">
          Loading card details…
        </p>
      ) : (
        <article
          aria-label="Printing detail"
          className={`flex flex-col gap-3 text-body ${OLD_BUTTONS} ${OLD_FIELDS} ${OLD_TEXT} [&_label]:flex [&_label]:flex-col [&_label]:gap-1 [&_label]:text-meta [&_label]:text-text-muted [&_textarea]:box-border [&_textarea]:rounded-control [&_textarea]:border [&_textarea]:border-solid [&_textarea]:border-border-strong [&_textarea]:bg-bg [&_textarea]:p-2 [&_textarea]:font-sans [&_textarea]:text-control [&_textarea]:text-text [&_form]:flex [&_form]:flex-col [&_form]:gap-3 [&_ul]:m-0 [&_ul]:list-none [&_ul]:p-0`}
        >
          <div className="flex flex-wrap gap-4">
            <CardArt url={printing.high_image_url} name={printing.name} />
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <p>
                {printing.set_name} ({request?.setCode ?? printing.set_id}) · #
                {printing.collector_number}
              </p>
              <p>Card Identity: {printing.identity_name}</p>
              <p>
                Source:{" "}
                {printing.source === "tcgdex"
                  ? "TCGdex"
                  : "Owner reviewed manual record"}
                {printing.source_id ? ` · ${printing.source_id}` : ""}
              </p>
              {printing.evidence_url && (
                <p>
                  Printing evidence:{" "}
                  <a
                    href={printing.evidence_url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open reviewed evidence
                  </a>
                </p>
              )}
              <p className="text-meta text-text-muted">
                Artwork belongs to the Printing and does not prove an Edition
                finish.
              </p>
            </div>
          </div>
          <h3 className="text-body font-semibold">Card Editions</h3>
          <ul className="flex flex-col gap-2">
            {printing.editions.map((edition) => (
              <li
                key={edition.id}
                className="flex flex-col gap-1 rounded-panel border border-border p-2"
              >
                <p>
                  <strong id={`edition-${edition.id}`}>
                    {variantLabel(edition.descriptor)}
                  </strong>
                  {" · "}
                  {edition.source === "manual"
                    ? "Owner reviewed manual Edition"
                    : "TCGdex Edition"}
                  {edition.evidence_url && (
                    <>
                      {" · "}
                      <a
                        href={edition.evidence_url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Reviewed evidence
                      </a>
                    </>
                  )}
                  {!edition.active && " · Unavailable"}
                </p>
                {edition.active && (
                  <p className="text-meta">
                    <EditionPrice editionId={edition.id} />
                  </p>
                )}
                <div>
                  <button
                    type="button"
                    aria-describedby={`edition-${edition.id}`}
                    onClick={() => setMetadata({ editionId: edition.id })}
                  >
                    Report metadata
                  </button>
                </div>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              aria-expanded={missingOpen}
              onClick={() => setMissingOpen((value) => !value)}
            >
              Report missing Edition
            </button>
            <button
              type="button"
              onClick={() => setMetadata({ editionId: null })}
            >
              Report Printing metadata
            </button>
          </div>
          {missingOpen && <MissingCardReports printingId={printing.id} />}
          {metadata && (
            <div ref={reportRef}>
              <MetadataReport
                key={metadata.editionId ?? "printing"}
                printingId={printing.id}
                printingName={printing.name}
                editions={printing.editions.map((edition) => ({
                  id: edition.id,
                  label: variantLabel(edition.descriptor),
                }))}
                initialEditionId={metadata.editionId}
                onSubmitted={onReported}
              />
            </div>
          )}
        </article>
      )}
    </Dialog>
  );
}
