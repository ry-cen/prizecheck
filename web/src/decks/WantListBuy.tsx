import { useEffect, useRef, useState } from "react";
import { MassEntryPanel } from "../DeckMassEntryExport";
import { countingLabel } from "../settings/wantListCounting";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import type { WantList } from "../want_list_generated";
import {
  getWantListMassEntry,
  wantListMassEntryDownloadHref,
  type WantListMassEntryView,
} from "../want_list_cost_generated";
import { EXPORT_CONTENT } from "./ExportDialog";
import { cards } from "./wantListModel";

const CHANGED = "The Want List changed; export again";

/** Whether a prepared export belongs to the Want List answer on the page. */
function answers(view: WantListMassEntryView, list: WantList): boolean {
  return (
    view.deck_id === list.deck_id &&
    view.want_list_counting === list.want_list_counting &&
    view.settings_revision === list.settings_revision &&
    view.owner_revision === list.owner_revision &&
    view.deck_lists_digest === list.deck_lists_digest
  );
}

/**
 * **Buy on TCGplayer** on the Want List (decklist import #210): a dialog with the TCGplayer Mass Entry export of exactly
 * what the page shows under the counting setting, the combined total or one Deck's needs. The dialog names the scope
 * ("Buy what Gardevoir ex needs") and the counting, and prepares the export as it opens. The panel is the deck builder's
 * (MassEntryPanel), so the link, the text, the coverage reasons and the less-specific wording are the same. A prepared
 * export for another state is discarded and the page reads the Want List again.
 */
export function WantListBuy({
  list,
  onChanged,
}: {
  /** The Want List answer the page shows. */
  list: WantList;
  /** An export named another state than the page shows: the page reads the Want List again. */
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const scoped = list.deck_id
    ? (list.decks.find((deck) => deck.id === list.deck_id)?.name ?? null)
    : null;
  return (
    <>
      <Button
        ref={button}
        variant="primary"
        className="self-center"
        disabled={list.to_get === "0"}
        onClick={() => setOpen(true)}
      >
        Buy on TCGplayer
      </Button>
      {/* Mounted only while open, so its title ("Buy what Gardevoir ex needs") is never in the page behind it. */}
      {open && (
        <Dialog
          open
          onClose={() => setOpen(false)}
          title={
            scoped ? `Buy what ${scoped} needs` : "Buy the Want List total"
          }
          closeLabel="Close TCGplayer export"
          size="wide"
          returnFocus={button}
          bodyClassName="flex flex-col gap-4"
        >
          <p className="m-0 text-body text-text wrap-anywhere">
            {cards(list.to_get)}, counted as{" "}
            <strong className="font-semibold">
              {countingLabel(list.want_list_counting)}
            </strong>
            .
          </p>
          <div
            className={EXPORT_CONTENT}
            onKeyDown={(event) => {
              // The TCGplayer confirmation's own handler closes it first; a cancelled keydown keeps the Dialog open.
              if (
                event.key === "Escape" &&
                event.target instanceof Element &&
                event.target.closest('div[role="dialog"]')
              )
                event.preventDefault();
            }}
          >
            <WantListMassEntry list={list} onChanged={onChanged} />
          </div>
        </Dialog>
      )}
    </>
  );
}

function WantListMassEntry({
  list,
  onChanged,
}: {
  list: WantList;
  onChanged: () => void;
}) {
  const [view, setView] = useState<WantListMassEntryView | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const latest = useRef(list);
  const attempt = useRef(0);
  latest.current = list;

  // A new Want List answer (a Swap, a reload) discards an export prepared for another state.
  useEffect(() => {
    if (view && !answers(view, list)) {
      setView(null);
      setNotice(CHANGED);
    }
  }, [list, view]);

  async function prepare() {
    const mine = ++attempt.current;
    setBusy(true);
    setNotice("");
    setView(null);
    try {
      const result = await getWantListMassEntry(list.deck_id);
      if (mine !== attempt.current) return;
      if (answers(result, latest.current)) setView(result);
      else {
        setNotice(CHANGED);
        onChanged();
      }
    } catch {
      if (mine === attempt.current)
        setNotice("The export could not be prepared. Try again.");
    } finally {
      if (mine === attempt.current) setBusy(false);
    }
  }

  // The dialog was opened to export: start once, as a press of the prepare button would.
  useEffect(() => {
    void prepare();
  }, []);

  return (
    <MassEntryPanel
      checks={{
        total: list.to_get,
        size_status: "complete",
        shortage: "0",
        excess: "0",
        disclaimer:
          "Estimated costs on the Want List use cached TCGplayer market prices (USD) and exclude shipping and taxes.",
      }}
      subject="these cards"
      busy={busy}
      onPrepare={() => void prepare()}
      view={view}
      downloadHref={
        view?.status === "text"
          ? wantListMassEntryDownloadHref(view)
          : undefined
      }
      notice={notice}
      emptyMessage="Every Deck can be built from your Collection."
    />
  );
}
