import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { LiveExportPanel } from "../DeckLiveExport";

const reasons = {
  rule_uncovered: "Live export isn't available for this Card Printing yet.",
  no_active_rule:
    "Live export is temporarily unavailable for this Card Printing.",
  missing_input:
    "This Card Printing is missing details needed for Live export.",
  invalid_input: "This Card Printing's details can't be used for Live export.",
  conflicting_input:
    "This Card Printing's details need to be resolved before Live export.",
  identity_review_pending:
    "This Card Printing's details need to be confirmed before Live export.",
  source_changed:
    "This Card Printing's details have changed and need to be confirmed before Live export.",
  recovery_conflict:
    "This Card Printing's details need to be resolved before Live export.",
  reviewed_unsupported: "This Card Printing can't be exported to Live.",
  physical_mismatch: "This Card Printing's details don't match a Live card.",
  future_reason_secret: "Live export isn't available for this Card Printing.",
  toString: "Live export isn't available for this Card Printing.",
};

for (const [reason, copy] of Object.entries(reasons)) {
  test(`explains ${reason} without exposing the API reason`, () => {
    const html = renderToStaticMarkup(
      createElement(LiveExportPanel, {
        checks: {
          total: "3",
          size_status: "short",
          shortage: "57",
          excess: "0",
          disclaimer: "Original disclaimer",
        },
        busy: false,
        onPrepare() {},
        resultKey: "1",
        status: "",
        result: {
          status: "blocked",
          text: null,
          byte_length: 0,
          blockers: [
            {
              name: "Furret",
              set_name: "Seed Set",
              collector_number: "136",
              quantity: "3",
              reason,
            },
          ],
        },
      })
    );
    // React escapes apostrophes in static HTML.
    const text = html.replaceAll("&#x27;", "'");
    expect(text).toContain(copy);
    expect(text).not.toContain(`· ${reason}<`);
    expect(text).toContain(
      "Live export isn't available for the cards below. No export was created."
    );
    expect(text).toContain("Furret · Seed Set #136 · ×3");
    expect(text).toContain("Original disclaimer");
    expect(text).not.toContain("reviewed Live data");
    expect(text).not.toContain("Copy for Live");
  });
}
