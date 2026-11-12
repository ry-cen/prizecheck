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
        "/catalog?format=bad&kind=bad&owned=yes&mode=bad&set=!!!&queue=secret"
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
