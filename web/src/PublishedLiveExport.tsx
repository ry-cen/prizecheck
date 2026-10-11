import { useEffect, useRef, useState } from "react";
import { LiveExportPanel } from "./DeckLiveExport";
import type { DeckChecks } from "./decks_generated";
import {
  getPublishedLiveExport,
  LiveExportError,
  publishedLiveExportDownloadHref,
  type PublishedLiveExportView,
} from "./live_export_generated";

// The Published Deck's Pokémon TCG Live export. Only the token and the snapshot version shown on this page are sent; the
// server derives every row and quantity. An answer for another version is discarded, and a 409 (republished or
// rewritten) or 404 (revoked) answer asks the page to read its snapshot again.
const CHANGED = "Published Deck changed; export again";

export type PublishedLiveExportProps = {
  token: string;
  version: number;
  checks: Pick<
    DeckChecks,
    "total" | "size_status" | "shortage" | "excess" | "disclaimer"
  >;
  onChanged: () => void;
};

export function PublishedLiveExport({
  token,
  version,
  checks,
  onChanged,
}: PublishedLiveExportProps) {
  const [result, setResult] = useState<PublishedLiveExportView | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const latest = useRef(version);
  const attempt = useRef(0);

  // A result belongs to one snapshot version; once the page shows another version it is discarded.
  useEffect(() => {
    latest.current = version;
    setResult((previous) => {
      if (previous && previous.version !== version) {
        setStatus(CHANGED);
        return null;
      }
      return previous;
    });
  }, [version]);

  async function prepare() {
    const mine = ++attempt.current;
    setBusy(true);
    setResult(null);
    setStatus("");
    try {
      const view = await getPublishedLiveExport(token, version);
      if (mine !== attempt.current) return;
      if (view.version !== latest.current) setStatus(CHANGED);
      else setResult(view);
    } catch (error) {
      if (mine !== attempt.current) return;
      if (
        error instanceof LiveExportError &&
        (error.status === 409 || error.status === 404)
      ) {
        setStatus(CHANGED);
        onChanged();
      } else setStatus("Live export is temporarily unavailable. Please retry.");
    } finally {
      if (mine === attempt.current) setBusy(false);
    }
  }

  return (
    <LiveExportPanel
      checks={checks}
      busy={busy}
      onPrepare={() => void prepare()}
      result={result}
      resultKey={result ? `${result.version}` : ""}
      downloadHref={
        result
          ? publishedLiveExportDownloadHref(token, result.version)
          : undefined
      }
      status={status}
    />
  );
}
