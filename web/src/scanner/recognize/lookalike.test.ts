import { describe, expect, it } from "vitest";
import { cosineRows, groupMembers, lookalikesOf } from "./lookalike";
import type { CardDb, Pcfp } from "./types";

// A tiny index by hand: dim 4, one row per id. Cosines are against row "A" = [10, 0, 0, 0].
const VECTORS: Record<string, number[]> = {
  A: [10, 0, 0, 0],
  B: [10, 2, 0, 0], // cos 0.98
  C: [10, 5, 0, 0], // cos 0.894
  D: [10, 20, 0, 0], // cos 0.447, below minCosine
  E: [10, 5, 0, 0], // ties with C
  F: [10, 5, 0, 0], // ties with C and E; older release than E
  G: [10, 0, 0, 0], // same group as nobody
  H: [10, 0, 0, 0], // null group
  N: [10, 0, 0, 0], // in the group, but no fingerprint
  Z: [0, 0, 0, 0], // zero norm
};
// Table order. Group 0 is A..F, N, Z; G is group 1 alone; H has no group.
const IDS = ["A", "B", "C", "D", "E", "F", "G", "H", "N", "Z"];
const GROUPS: (number | null)[] = [0, 0, 0, 0, 0, 0, 1, null, 0, 0];

function db(groups: (number | null)[] | undefined = GROUPS): CardDb {
  const released = new Map([
    ["C", "2020-01-01"],
    ["E", "2022-01-01"],
    ["F", "2021-01-01"],
  ]);
  const sets = [...new Set(released.values())].map((r) => ({
    id: r,
    code: null,
    official: null,
    total: null,
    released: r,
  }));
  sets.push({
    id: "none",
    code: null,
    official: null,
    total: null,
    released: null as never,
  });
  const setOfRow = new Int32Array(IDS.length);
  IDS.forEach((id, i) => {
    const r = released.get(id);
    setOfRow[i] = r ? sets.findIndex((s) => s.id === r) : sets.length - 1;
  });
  return {
    key: "k",
    ids: IDS,
    rowOf: new Map(IDS.map((id, i) => [id, i])),
    setOfRow,
    numbers: IDS.map(() => "1"),
    names: IDS.map(() => "n"),
    art: IDS.map(() => null),
    groups,
    sets,
  };
}

function pcfp(ids: string[]): Pcfp {
  const q = new Int8Array(ids.length * 4);
  ids.forEach((id, i) => q.set(VECTORS[id], i * 4));
  return {
    dim: 4,
    count: ids.length,
    modelSha256: "",
    ids,
    scale: new Float32Array(ids.length).fill(1),
    q,
  };
}

function data(fpIds: string[] | null = IDS.filter((i) => i !== "N")) {
  const d = db();
  const fp = fpIds ? pcfp(fpIds) : null;
  return {
    db: d,
    groups: groupMembers(d),
    fp,
    fpRows: fp ? new Map(fp.ids.map((id, i) => [id, i])) : null,
  };
}

describe("lookalikesOf", () => {
  it("members of the same group at or above minCosine, closest first", () => {
    expect(lookalikesOf("A", data(), 0.85)).toEqual(["B", "E", "F", "C"]);
    expect(lookalikesOf("A", data(), 0.9)).toEqual(["B"]);
  });

  it("a member below minCosine, another group or a null group is left out", () => {
    const out = lookalikesOf("A", data());
    expect(out).not.toContain("D");
    expect(out).not.toContain("G");
    expect(out).not.toContain("H");
    expect(out).not.toContain("A");
    expect(lookalikesOf("G", data())).toEqual([]);
    expect(lookalikesOf("H", data())).toEqual([]);
  });

  it("a member with no fingerprint is left out", () => {
    expect(lookalikesOf("A", data())).not.toContain("N");
    expect(lookalikesOf("N", data())).toEqual([]);
    expect(lookalikesOf("A", data())).not.toContain("Z"); // zero norm: cosine 0
  });

  it("ties order by newer release, then id", () => {
    // C (2020), E (2022), F (2021) tie at one cosine; B is closer.
    expect(lookalikesOf("A", data())).toEqual(["B", "E", "F", "C"]);
    // With no release dates the id decides.
    const d = data();
    d.db.setOfRow.fill(d.db.sets.length - 1);
    expect(lookalikesOf("A", d)).toEqual(["B", "C", "E", "F"]);
  });

  it("a table without groups gives []", () => {
    const d = data();
    expect(
      lookalikesOf("A", { ...d, db: { ...db(), groups: undefined } })
    ).toEqual([]);
  });

  it("no fingerprints: []", () => {
    expect(lookalikesOf("A", data(null))).toEqual([]);
  });
});

describe("groupMembers and cosineRows", () => {
  it("keeps groups of two or more, in table order", () => {
    const m = groupMembers(db());
    expect([...m.keys()]).toEqual([0]);
    expect(m.get(0)).toEqual(["A", "B", "C", "D", "E", "F", "N", "Z"]);
    expect(groupMembers({ ...db(), groups: undefined }).size).toBe(0);
  });

  it("cosineRows is scale free and 0 for a zero row", () => {
    const fp = pcfp(["A", "B", "Z"]);
    expect(cosineRows(fp, 0, 0)).toBeCloseTo(1, 10);
    expect(cosineRows(fp, 0, 1)).toBeCloseTo(10 / Math.sqrt(104), 10);
    expect(cosineRows(fp, 0, 2)).toBe(0);
  });
});
