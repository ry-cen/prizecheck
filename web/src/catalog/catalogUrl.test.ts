import { describe, expect, it } from "vitest";
import { catalogHref, parseCatalogView } from "./catalogUrl";
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
