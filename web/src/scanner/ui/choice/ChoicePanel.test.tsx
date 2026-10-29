import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChoicePanel } from "./ChoicePanel";
import type { ChoiceView } from "./controller";

const view: ChoiceView = {
  lockId: 1,
  kind: "version",
  versions: [
    {
      printingId: "p1",
      name: "Bulbasaur",
      setLine: "Base Set 44/102",
      image: null,
      editions: [
        { id: "p1-n", label: "Normal" },
        { id: "p1-r", label: "Reverse Holo" },
      ],
    },
    {
      printingId: "p2",
      name: "Bulbasaur",
      setLine: "Base Set 2 30/130",
      image: null,
      editions: [
        { id: "p2-n", label: "Normal" },
        { id: "p2-r", label: "Reverse Holo" },
      ],
    },
    {
      printingId: "p3",
      name: "Rare Candy",
      setLine: "Mega 125",
      image: null,
      editions: [{ id: "p3-h", label: "Holo" }],
    },
  ],
};

describe("ChoicePanel", () => {
  const html = renderToStaticMarkup(
    <ChoicePanel
      view={view}
      onPick={() => {}}
      onNone={() => {}}
      listRef={null}
    />
  );

  it("labels each finish group with its name and set line, so same-name versions differ", () => {
    expect(html).toContain('aria-label="Finish of Bulbasaur, Base Set 44/102"');
    expect(html).toContain(
      'aria-label="Finish of Bulbasaur, Base Set 2 30/130"'
    );
  });

  it("shows a single-finish version's finish after its set and number", () => {
    expect(html).toContain("Mega 125");
    expect(html).toMatch(/Mega 125(<!-- -->)? · (<!-- -->)?Holo/);
  });
});
