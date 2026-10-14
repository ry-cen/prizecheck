import { useEffect, useRef, useState } from "react";
import type { DeckChecks } from "./decks_generated";
import { ExportOutput } from "./ExportOutput";
import {
  getLiveExport,
  liveExportDownloadHref,
  type LiveBlockerView,
  type LiveExportView,
} from "./live_export_generated";

export type DeckExportProps = {
  deckId: string;
  ownerRevision: number;
  /** The Deck List's own basic checks (`deck_list_checks`): both exports read the Deck List, never the Holdings. */
  checks: DeckChecks;
  /** The Deck List revision the page drew: a result for another revision is discarded too, as a Deck List edit
   * doesn't move the inventory revision (#181). */
  deckListRevision?: number;
  /** A result named a revision the page hasn't read: the page reads the Deck again, so the next export can match. */
  onStale?: () => void;
};

const CHANGED = "Deck changed; export again";

/** What the Live panel renders; the private view and the Published Deck view both carry these fields. */
export type LiveResult = Pick<
  LiveExportView,
  "status" | "text" | "byte_length"
> & {
  blockers: Pick<
    LiveBlockerView,
    "name" | "set_name" | "collector_number" | "quantity" | "reason"
  >[];
};
export type LiveChecks = Pick<
  DeckChecks,
  "total" | "size_status" | "shortage" | "excess" | "disclaimer"
>;

export function DeckLiveExport({
  deckId,
  ownerRevision,
  checks,
  deckListRevision,
  onStale,
}: DeckExportProps) {
  const [result, setResult] = useState<LiveExportView | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const latest = useRef({ owner: ownerRevision, list: deckListRevision });
  const matches = (view: LiveExportView) =>
    view.owner_revision === latest.current.owner &&
    (latest.current.list === undefined ||
      view.deck_list_revision === latest.current.list);

  // A result belongs to one inventory revision and one Deck List revision; a newer one discards it.
  useEffect(() => {
    latest.current = { owner: ownerRevision, list: deckListRevision };
    setResult((previous) => {
      if (previous && !matches(previous)) {
        setStatus(CHANGED);
        return null;
      }
      return previous;
    });
  }, [ownerRevision, deckListRevision]);

  async function prepare() {
    setBusy(true);
    setResult(null);
    setStatus("");
    try {
      const view = await getLiveExport(deckId);
      if (!matches(view)) {
        setStatus(CHANGED);
        onStale?.();
      } else setResult(view);
    } catch {
      setStatus("Live export is temporarily unavailable. Please retry.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <LiveExportPanel
      checks={checks}
      busy={busy}
      onPrepare={() => void prepare()}
      result={result}
      resultKey={result ? `${result.owner_revision}` : ""}
      downloadHref={
        result
          ? liveExportDownloadHref(
              deckId,
              result.owner_revision,
              deckListRevision === undefined
                ? undefined
                : result.deck_list_revision
            )
          : undefined
      }
      status={status}
    />
  );
}

// Renders the Live export: empty Deck, the prepare button, complete text with Copy and Download, or every blocker. It never fetches.
export function LiveExportPanel({
  checks,
  busy,
  onPrepare,
  result,
  resultKey,
  downloadHref,
  status,
}: {
  checks: LiveChecks;
  busy: boolean;
  onPrepare: () => void;
  result: LiveResult | null;
  resultKey: string;
  downloadHref?: string;
  status: string;
}) {
  const empty = checks.total === "0";
  const warnings =
    checks.size_status === "complete" ? undefined : (
      <p>
        This Deck has {checks.total} cards, not 60. The export lists exactly the
        cards on its Deck List.
      </p>
    );
  const disclaimer = <p>{checks.disclaimer}</p>;

  if (empty)
    return (
      <ExportOutput
        label="Live export"
        text={null}
        byteLength={0}
        empty
        emptyMessage="No cards"
        copyLabel="Copy for Live"
        disclaimer={disclaimer}
      />
    );
  return (
    <section aria-label="Pokémon TCG Live export">
      <h3>Pokémon TCG Live</h3>
      <button type="button" disabled={busy} onClick={onPrepare}>
        Export to Live
      </button>
      {result?.status === "ok" && (
        <ExportOutput
          key={resultKey}
          label="Live export"
          text={result.text}
          byteLength={result.byte_length}
          downloadHref={downloadHref}
          downloadName="deck-live-export.txt"
          copyLabel="Copy for Live"
          downloadLabel="Download Live export"
          warnings={warnings}
          disclaimer={disclaimer}
          status={status}
        />
      )}
      {result?.status === "blocked" && (
        <div role="region" aria-label="Live export blockers">
          <p>
            This Deck cannot be exported yet. {result.blockers.length} card
            {result.blockers.length === 1 ? "" : "s"} lack reviewed Live data.
            Nothing was left out of a partial list.
          </p>
          <ul>
            {result.blockers.map((blocker, index) => (
              <li key={index}>
                {blocker.name} · {blocker.set_name} #{blocker.collector_number}{" "}
                · ×{blocker.quantity} · {blocker.reason}
              </li>
            ))}
          </ul>
          {disclaimer}
        </div>
      )}
      {result?.status === "empty" && <p>No cards</p>}
      {result?.status !== "ok" && <p role="status">{status}</p>}
    </section>
  );
}
