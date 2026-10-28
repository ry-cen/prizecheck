import { describe, expect, it } from "vitest";
import { parseCardTable } from "../recognize/cardTable";
import { facesFrom } from "./offlineCards";

const sets = [
  { id: "a", code: "AA", official: 10, total: 12, released: "2020-01-01" },
];
const base = {
  key: "k",
  catalog_revision: 1,
  sets,
};
const cols = {
  id: ["u1", "u2"],
  set: [0, 0],
  number: ["1", "2"],
  name: ["One", "Two"],
};

describe("offline faces", () => {
  it("builds the art route URL from a format 2 table, and none for a card without art", () => {
    const face = facesFrom(
      parseCardTable({
        ...base,
        format: 2,
        printings: { ...cols, art: [null, "0a1b2c3d"] },
      })
    );
    expect(face("u2")?.image).toBe("/api/art/u2/small?v=0a1b2c3d");
    expect(face("u1")?.image).toBeNull();
    expect(face("nope")).toBeNull();
  });

  it("never returns a bare URL from a format 1 table", () => {
    const face = facesFrom(
      parseCardTable({
        ...base,
        format: 1,
        printings: { ...cols, image: ["http://x/1", "http://x/2"] },
      })
    );
    expect(face("u1")?.image).toBeNull();
    expect(face("u2")?.image).toBeNull();
  });
});
