import { useEffect, useMemo, useState } from "react";
import { Correction } from "../EditionCorrections";
import {
  getEditionReplacements,
  type ReplacementView,
} from "../reconciliation_generated";
import type { GalleryHolding } from "./galleryModel";
import "./CorrectionsNotice.css";

type Props = {
  holdings: GalleryHolding[];
  /** The gallery's owner revision. The reviewed corrections are read again whenever it changes. */
  ownerRevision: number | null;
  /** Reloads the gallery and the tree after a reassignment. */
  onChanged: () => Promise<void>;
};

/** Reviewed Edition corrections for the loaded cards in this view (ticket 114; the old Locations page showed them
 * per Storage Leaf). One reassignment control per Holding whose Edition has a reviewed replacement. */
export function CorrectionsNotice({
  holdings,
  ownerRevision,
  onChanged,
}: Props) {
  const [corrections, setCorrections] = useState<ReplacementView[]>([]);
  useEffect(() => {
    let live = true;
    getEditionReplacements()
      .then((list) => {
        if (live) setCorrections(Array.isArray(list) ? list : []);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [ownerRevision]);
  const relevant = useMemo(() => {
    const byEdition = new Map(corrections.map((item) => [item.edition_id, item]));
    return holdings.flatMap((entry) => {
      const correction = byEdition.get(entry.holding.edition_id);
      return correction ? [{ entry, correction }] : [];
    });
  }, [corrections, holdings]);
  if (!relevant.length) return null;
  return (
    <section
      className="ws-corrections"
      aria-label="Reviewed Edition corrections"
    >
      <h2 className="ws-corrections-title">Reviewed Edition corrections</h2>
      {relevant.map(({ entry, correction }) => (
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
