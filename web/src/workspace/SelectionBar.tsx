import React from "react";
import { plural } from "./galleryModel";
import type { SelectionSummary } from "./selectionModel";
import "./Selection.css";

type Props = {
  summary: SelectionSummary;
  onClear: () => void;
  /** Opens the details sheet for the last clicked selected card (mobile). */
  onDetails: () => void;
};

/** The selection bar: floating at the bottom centre on desktop, a compact strip on mobile.
 * Shown only while one or more copies are selected. */
export function SelectionBar({ summary, onClear, onDetails }: Props) {
  return (
    <section className="ws-selection-bar" aria-label="Selection">
      <p className="ws-selection-text">
        <strong>{plural(summary.copies, "copy", "copies")} selected</strong>
        <span className="ws-selection-detail">
          {plural(summary.editions, "edition", "editions")} ·{" "}
          {plural(summary.locations, "location", "locations")}
        </span>
      </p>
      <span className="ws-selection-actions">
        <button type="button" className="ws-mobile-only" onClick={onDetails}>
          Details
        </button>
        {/* Ticket 107 adds Actions (Move, Inventory Removal, Clear) here and folds Clear into it. */}
        <button type="button" aria-label="Clear selection" onClick={onClear}>
          Clear
        </button>
      </span>
    </section>
  );
}
