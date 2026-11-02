import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MatchPrintingChoices } from "./MatchPrintingChoices";
import { EMPTY_PROPOSAL, type ProposalMatch } from "./proposalModel";

const first = {
  edition_id: "pal",
  name: "Iono",
  set_code: "PAL",
  set_name: "Paldea Evolved",
  collector_number: "185",
  descriptor: {},
  image_url: null,
  copies: "2",
  need_groups: ["shared"],
};
const cards = [
  first,
  { ...first, edition_id: "paf", set_code: "PAF", collector_number: "080" },
];
const groups = [{ id: "shared", need: "2", cards: "2" }];

describe("printing choice button names", () => {
  for (const side of ["get", "give"] as const) {
    it(`includes the visible label and distinguishes printings on You ${side}`, () => {
      const row: ProposalMatch = {
        you_get: side === "get" ? cards : [],
        you_get_groups: side === "get" ? groups : [],
        you_give: side === "give" ? cards : [],
        you_give_groups: side === "give" ? groups : [],
      };
      const markup = renderToStaticMarkup(
        createElement(MatchPrintingChoices, {
          side,
          row,
          proposal: EMPTY_PROPOSAL,
          onChoose: () => {},
        })
      );
      const names = [
        ...markup.matchAll(/<button\b[^>]*aria-label="([^"]+)"[^>]*>/g),
      ].map((match) => match[1]);
      expect(names).toHaveLength(2);
      expect(new Set(names).size).toBe(2);
      for (const name of names) {
        expect(name).toMatch(/^Choose this printing: /);
        expect(name).toContain("Iono");
        expect(name).toMatch(new RegExp(`for You ${side}$`));
      }
      expect(names[0]).toContain("PAL 185");
      expect(names[1]).toContain("PAF 080");
      expect(markup.match(/>Choose this printing<\/button>/g)).toHaveLength(2);
    });
  }
});
