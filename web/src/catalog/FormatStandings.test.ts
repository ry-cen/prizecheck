import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import type { EditionStandings } from "../catalog_browse_generated";
import { FormatStandings } from "./FormatStandings";

const unknown = {
  status: "unknown",
  reasons: ["regulation mark not recorded"],
} as const;
const legal = { status: "legal", reasons: [] } as const;
const notLegal = {
  status: "not_legal",
  reasons: ["internal rule detail"],
} as const;

function render(
  statuses: [
    "unknown" | "legal" | "not_legal",
    "unknown" | "legal" | "not_legal",
    "unknown" | "legal" | "not_legal",
  ]
) {
  const values = { unknown, legal, not_legal: notLegal };
  const standing: EditionStandings = {
    standard: {
      ...values[statuses[0]],
      reasons: [...values[statuses[0]].reasons],
    },
    expanded: {
      ...values[statuses[1]],
      reasons: [...values[statuses[1]].reasons],
    },
    glc: { ...values[statuses[2]], reasons: [...values[statuses[2]].reasons] },
  };
  return renderToStaticMarkup(
    createElement(FormatStandings, { standing, labelledBy: "legality" })
  );
}

test("two unknown Formats share one line while known standings remain visible", () => {
  const markup = render(["unknown", "unknown", "legal"]);
  expect(markup).toContain("Standard and Expanded legality unknown");
  expect(markup).toContain("GLC: Legal");
  expect(markup.match(/legality unknown/g)).toHaveLength(1);
  expect(markup).not.toContain("regulation mark");
  expect(markup).not.toContain(": Unknown");
});

test("a single unknown Format keeps its name", () => {
  const markup = render(["legal", "unknown", "not_legal"]);
  expect(markup).toContain("Expanded legality unknown");
  expect(markup).toContain("Standard: Legal");
  expect(markup).toContain("GLC: Not legal");
  expect(markup).not.toContain("internal rule detail");
});

test("all unknown Formats are named once with no empty list", () => {
  const markup = render(["unknown", "unknown", "unknown"]);
  expect(markup).toContain("Standard, Expanded, and GLC legality unknown");
  expect(markup.match(/<p /g)).toHaveLength(1);
  expect(markup).not.toContain("<ul");
});

test("known standings retain their list and have no unknown message", () => {
  const markup = render(["legal", "not_legal", "legal"]);
  expect(markup).toContain('aria-labelledby="legality"');
  expect(markup).toContain("Standard: Legal");
  expect(markup).toContain("Expanded: Not legal");
  expect(markup).toContain("GLC: Legal");
  expect(markup).not.toContain("legality unknown");
});
