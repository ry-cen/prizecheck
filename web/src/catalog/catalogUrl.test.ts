import { describe, expect, it } from "vitest";
import {
  catalogCardHref,
  catalogHref,
  parseCatalogCard,
  parseCatalogView,
} from "./catalogUrl";
describe("catalog URL", () => {
  it("round trips meaningful public state only", () => {
    const view = {
      q: "Ivysaur",
      format: "standard",
      kind: "pokemon",
      setId: "sv02",
      owned: true,
      mode: "add",
    } as const;
    expect(parseCatalogView(catalogHref(view))).toEqual(view);
  });
  it("ignores invalid and private parameters", () => {
    expect(
      parseCatalogView(
        "/catalog?format=bad&kind=bad&owned=yes&mode=bad&set=invalid/&queue=secret"
      )
    ).toEqual({
      q: "",
      format: null,
      kind: null,
      setId: null,
      owned: false,
      mode: null,
    });
  });
});

it.each(["sv03.5", "sv08.5", "swsh12.5gg"])(
  "round trips real dotted set %s",
  (setId) => {
    const view = { ...parseCatalogView("/catalog"), setId };
    expect(parseCatalogView(catalogHref(view))).toEqual(view);
  }
);
it("ignores values above browse endpoint limits", () => {
  expect(
    parseCatalogView(`/catalog?q=${"x".repeat(121)}&set=${"x".repeat(81)}`)
  ).toMatchObject({ q: "", setId: null });
  expect(
    parseCatalogView(`/catalog?q=${"x".repeat(120)}&set=${"x".repeat(80)}`)
  ).toMatchObject({ q: "x".repeat(120), setId: "x".repeat(80) });
});

const P = "0a1b2c3d-0000-4000-8000-00000000000a";
const E = "0A1B2C3D-0000-4000-8000-00000000000B";
describe("catalog card address", () => {
  it("accepts UUIDs in either case", () => {
    expect(parseCatalogCard(`/catalog?card=${P}&edition=${E}`)).toEqual({
      printingId: P,
      editionId: E,
    });
    expect(parseCatalogCard(`/catalog?card=${P.toUpperCase()}`)).toEqual({
      printingId: P.toUpperCase(),
      editionId: null,
    });
  });
  it.each(["abc", "", `${P}x`, ` ${P}`, `${P}${P}`])(
    "rejects the malformed card %j",
    (card) => {
      expect(
        parseCatalogCard(`/catalog?card=${encodeURIComponent(card)}`)
      ).toBeNull();
    }
  );
  it("has no card without the card parameter, even with an edition", () => {
    expect(parseCatalogCard(`/catalog?edition=${E}`)).toBeNull();
  });
  it("drops a bad edition and keeps the card", () => {
    expect(parseCatalogCard(`/catalog?card=${P}&edition=nope`)).toEqual({
      printingId: P,
      editionId: null,
    });
  });
  it("writes card then edition after the view, with ? or &", () => {
    const view = parseCatalogView("/catalog?mode=add&q=Eevee&set=sv02");
    expect(catalogCardHref(view, { printingId: P, editionId: E })).toBe(
      `/catalog?q=Eevee&set=sv02&mode=add&card=${P}&edition=${encodeURIComponent(E)}`
    );
    expect(
      catalogCardHref(parseCatalogView("/catalog"), {
        printingId: P,
        editionId: null,
      })
    ).toBe(`/catalog?card=${P}`);
    expect(catalogCardHref(view, null)).toBe(catalogHref(view));
  });
  it("never writes a card from catalogHref, even for a view parsed from a card address", () => {
    const view = parseCatalogView(`/catalog?q=Eevee&card=${P}&edition=${E}`);
    expect(catalogHref(view)).toBe("/catalog?q=Eevee");
  });
});
