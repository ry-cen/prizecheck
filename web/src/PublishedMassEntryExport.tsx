import { useEffect, useRef, useState } from "react";
import { MassEntryPanel } from "./DeckMassEntryExport";
import type { DeckChecks } from "./decks_generated";
import {
  MassEntryError,
  getPublishedMassEntry,
  publishedMassEntryDownloadHref,
  type PublishedMassEntryView,
} from "./mass_entry_generated";

// The Published Deck's TCGplayer Mass Entry export. Only the token and the snapshot version shown on this page are sent.
// An answer for another version is discarded; a 409 or 404 answer asks the page to read its snapshot again.
const CHANGED = "Published Deck changed; export again";

export type PublishedMassEntryExportProps = {
  token: string;
  version: number;
  checks: Pick<
    DeckChecks,
    "total" | "size_status" | "shortage" | "excess" | "disclaimer"
  >;
  onChanged: () => void;
};

export function PublishedMassEntryExport({
  token,
  version,
  checks,
  onChanged,
}: PublishedMassEntryExportProps) {
  const [view, setView] = useState<PublishedMassEntryView | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const latest = useRef(version);
  const attempt = useRef(0);

  // A result belongs to one snapshot version; once the page shows another version it is discarded.
  useEffect(() => {
    latest.current = version;
    setView((previous) => {
      if (previous && previous.version !== version) {
        setNotice(CHANGED);
        return null;
      }
      return previous;
    });
  }, [version]);

  async function prepare() {
    const mine = ++attempt.current;
    setBusy(true);
    setView(null);
    setNotice("");
    try {
      const result = await getPublishedMassEntry(token, version);
      if (mine !== attempt.current) return;
      if (result.version !== latest.current) setNotice(CHANGED);
      else setView(result);
    } catch (error) {
      if (mine !== attempt.current) return;
      if (
        error instanceof MassEntryError &&
        (error.status === 409 || error.status === 404)
      ) {
        setNotice(CHANGED);
        onChanged();
      } else setNotice("The export could not be prepared. Try again.");
    } finally {
      if (mine === attempt.current) setBusy(false);
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
          ? publishedMassEntryDownloadHref(token, view.version)
          : undefined
      }
      notice={notice}
    />
  );
}
