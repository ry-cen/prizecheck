import { useEffect, useMemo, useRef, useState } from "react";
import { Correction } from "../EditionCorrections";
import {
  getEditionReplacements,
  type ReplacementView,
} from "../reconciliation_generated";
import type { GalleryHolding, GalleryStatus } from "./galleryModel";
import "./CorrectionsNotice.css";

type Relevant = { entry: GalleryHolding; correction: ReplacementView }[];
/** One empty list, so a view without corrections never re-renders or re-walks for them. */
const NONE: Relevant = [];

type Props = {
  holdings: GalleryHolding[];
  /** The gallery's status. While it loads (or is partial), the last settled list for this query stays shown. */
  status: GalleryStatus;
  /** The gallery query's key: a kept list belongs to one query. */
  galleryKey: string;
  /** The gallery's owner and catalog revisions; the reviewed corrections are read once per pair. Null while it reloads. */
  ownerRevision: number | null;
  catalogRevision: number | null;
  /** Reloads the gallery and the tree after a reassignment. */
  onChanged: () => Promise<void>;
};

/** Reviewed Edition corrections for the loaded cards in this view (ticket 114; the old Locations page showed them
 * per Storage Leaf). One reassignment control per Holding whose Edition has a reviewed replacement. */
export function CorrectionsNotice({
  holdings,
  status,
  galleryKey,
  ownerRevision,
  catalogRevision,
  onChanged,
}: Props) {
  const [corrections, setCorrections] = useState<ReplacementView[]>([]);
  // As useOwnedSets: the newest request wins, and a reload (revisions null) neither reads nor cancels.
  const requested = useRef("");
  useEffect(() => {
    if (ownerRevision === null || catalogRevision === null) return;
    const key = `${ownerRevision}:${catalogRevision}`;
    if (requested.current === key) return;
    requested.current = key;
    getEditionReplacements()
      .then((list) => {
        if (requested.current === key)
          setCorrections(Array.isArray(list) ? list : []);
      })
      .catch(() => {
        // Forget a failed read so the next reload (revisions null, then back) retries it.
        if (requested.current === key) requested.current = "";
      });
  }, [ownerRevision, catalogRevision]);
  const relevant = useMemo(() => {
    if (!corrections.length) return NONE;
    const byEdition = new Map(
      corrections.map((item) => [item.edition_id, item])
    );
    return holdings.flatMap((entry) => {
      const correction = byEdition.get(entry.holding.edition_id);
      return correction ? [{ entry, correction }] : [];
    });
  }, [corrections, holdings]);
  // A reload empties the listing until its pages return. Keep showing the last settled list for this query, so
  // a Correction isn't unmounted and keeps what the collector typed.
  const settled = status === "ready" || status === "error";
  const [kept, setKept] = useState({ key: galleryKey, list: relevant });
  if (settled && (kept.key !== galleryKey || kept.list !== relevant))
    setKept({ key: galleryKey, list: relevant });
  const shown =
    !settled && kept.key === galleryKey && kept.list.length
      ? kept.list
      : relevant;
  if (!shown.length) return null;
  return (
    <section
      className="ws-corrections"
      aria-label="Reviewed Edition corrections"
    >
      <h2 className="ws-corrections-title">Reviewed Edition corrections</h2>
      {shown.map(({ entry, correction }) => (
        <Correction
          key={entry.key}
          holding={entry.holding}
          correction={correction}
          onChanged={onChanged}
          headingLevel={3}
        />
      ))}
    </section>
  );
}
