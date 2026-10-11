import { useEffect, useRef, useState } from "react";
import type { DeckExportProps } from "./DeckLiveExport";
import type { DeckChecks } from "./decks_generated";
import { ExportOutput } from "./ExportOutput";
import {
  MASS_ENTRY_DOWNLOAD_NAME,
  getMassEntryExport,
  massEntryDownloadHref,
  type MassEntryView,
} from "./mass_entry_generated";

const REASONS: Record<NonNullable<MassEntryView["fallback_reason"]>, string> = {
  missing_mapping:
    "No TCGplayer link is offered because at least one card has no verified TCGplayer product. The complete text below lists every card.",
  encoded_length:
    "No TCGplayer link is offered because it would be longer than 2,000 characters, which this app treats as too long to open reliably. The complete text below lists every card.",
  quantity_unsupported:
    "No TCGplayer link is offered because one product needs more than 999 copies, more than this app puts in a link. The complete text below keeps every quantity.",
};

/** What the Mass Entry panel renders; the private view and the Published Deck view both carry these fields. */
export type MassEntryResult = Omit<
  MassEntryView,
  "owner_revision" | "catalog_revision"
>;
export type MassEntryChecks = Pick<
  DeckChecks,
  "total" | "size_status" | "shortage" | "excess" | "disclaimer"
>;

export function MassEntryPanel({
  checks,
  busy,
  onPrepare,
  view,
  downloadHref,
  notice,
}: {
  checks: MassEntryChecks;
  busy: boolean;
  onPrepare: () => void;
  view: MassEntryResult | null;
  downloadHref?: string;
  notice: string;
}) {
  const [confirming, setConfirming] = useState(false);
  // A new or discarded export never inherits an open confirmation.
  useEffect(() => setConfirming(false), [view]);
  const empty = checks.total === "0";

  const size =
    checks.size_status === "complete" ? null : (
      <p>
        This Deck has {checks.total} cards, not 60 (
        {checks.size_status === "shortage"
          ? `${checks.shortage} short`
          : `${checks.excess} over`}
        ). It can still be exported; nothing here says whether it is legal to
        play.
      </p>
    );
  const lessSpecific =
    view && view.less_specific_count > 0 ? (
      <p>
        Less specific: {view.less_specific_count} of {view.line_count} rows give
        only a card name. TCGplayer may resolve a row to a different Printing
        than the one in your Deck.
      </p>
    ) : null;
  const warnings = (
    <>
      {size}
      {view?.status === "text" && view.fallback_reason && (
        <p>{REASONS[view.fallback_reason]}</p>
      )}
      {view?.status === "text" && lessSpecific}
    </>
  );
  const disclaimer = (
    <>
      <p>{checks.disclaimer}</p>
      <p>
        Opening TCGplayer does not buy anything and shows no price for this
        Deck.
      </p>
    </>
  );

  return (
    <section aria-label="TCGplayer export">
      <h3>TCGplayer Mass Entry</h3>
      <button type="button" disabled={busy || empty} onClick={onPrepare}>
        {busy ? "Preparing…" : "Prepare TCGplayer export"}
      </button>
      {view?.status === "link" && view.url && (
        <div>
          <p>
            Every card has a verified TCGplayer product ({view.line_count}{" "}
            Printings, {view.total_copies} copies).
          </p>
          <button type="button" onClick={() => setConfirming(true)}>
            Open in TCGplayer
          </button>
          {confirming && (
            <div
              role="dialog"
              aria-modal="true"
              aria-label="Before you open TCGplayer"
              onKeyDown={(event) => {
                if (event.key === "Escape") setConfirming(false);
              }}
            >
              <p>
                Product matching does not guarantee the finish or condition of
                the cards TCGplayer selects. Review every selection on TCGplayer
                before you continue. Nothing is purchased by opening the page.
              </p>
              <a
                href={view.url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setConfirming(false)}
              >
                Continue to TCGplayer
              </a>{" "}
              <button
                type="button"
                autoFocus
                onClick={() => setConfirming(false)}
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      )}
      <ExportOutput
        label="TCGplayer Mass Entry"
        text={view?.status === "text" ? view.text : null}
        byteLength={view?.status === "text" ? view.byte_length : 0}
        downloadHref={downloadHref}
        downloadName={MASS_ENTRY_DOWNLOAD_NAME}
        empty={empty}
        emptyMessage="No cards"
        warnings={warnings}
        disclaimer={disclaimer}
        status={notice}
        copyLabel="Copy text"
        downloadLabel="Download text"
      />
    </section>
  );
}

export function DeckMassEntryExport({
  deckId,
  ownerRevision,
  checks,
}: DeckExportProps) {
  const [view, setView] = useState<MassEntryView | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const revision = useRef(ownerRevision);
  const latest = useRef(0);
  revision.current = ownerRevision;

  // An inventory change makes a prepared export untrustworthy; discard it instead of showing old quantities.
  useEffect(() => {
    if (view && view.owner_revision !== ownerRevision) {
      setView(null);
      setNotice("Deck changed; export again");
    }
  }, [ownerRevision, view]);

  async function prepare() {
    const attempt = ++latest.current;
    setBusy(true);
    setNotice("");
    setView(null);
    try {
      const result = await getMassEntryExport(deckId);
      if (attempt !== latest.current) return;
      if (result.owner_revision !== revision.current) {
        setNotice("Deck changed; export again");
      } else {
        setView(result);
      }
    } catch {
      if (attempt === latest.current)
        setNotice("The export could not be prepared. Try again.");
    } finally {
      if (attempt === latest.current) setBusy(false);
    }
  }

  return (
    <MassEntryPanel
      checks={checks}
      busy={busy}
      onPrepare={() => void prepare()}
      view={view}
      downloadHref={
        view?.status === "text"
          ? massEntryDownloadHref(deckId, view.owner_revision)
          : undefined
      }
      notice={notice}
    />
  );
}
