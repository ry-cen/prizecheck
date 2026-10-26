import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIX } from "../fixtures/read";
import { f32, loadLogic } from "../fixtures/recognizeUtil";
import { ctcDecode, loadClasses } from "./ctc";

const classes = loadClasses(readFileSync(join(FIX, "dict.txt"), "utf8"));

describe("ctc", () => {
  it("dict.txt gives 438 classes, blank first and space last", () => {
    expect(classes.length).toBe(438);
    expect(classes[0]).toBe("<blank>");
    expect(classes[437]).toBe(" ");
  });
  it("loadClasses drops exactly one trailing empty entry", () => {
    expect(loadClasses("a\nb\n")).toEqual(["<blank>", "a", "b", " "]);
    expect(loadClasses("a\nb")).toEqual(["<blank>", "a", "b", " "]);
    expect(loadClasses("a\n\n")).toEqual(["<blank>", "a", "", " "]);
  });
  it("decodes the Python cases exactly", () => {
    for (const c of loadLogic().ctc) {
      expect(ctcDecode(f32(c.file), c.T, c.C, classes)).toBe(c.text);
    }
  });
  it("collapses repeats, keeps repeats separated by a blank, takes the first maximum", () => {
    const cls = ["<blank>", "a", "b", " "];
    const lg = (idx: number[]) => {
      const out = new Float32Array(idx.length * 4);
      idx.forEach((k, t) => {
        out[t * 4 + k] = 1;
      });
      return out;
    };
    expect(ctcDecode(lg([1, 1, 0, 1, 2, 2, 0]), 7, 4, cls)).toBe("aab");
    expect(ctcDecode(new Float32Array(8), 2, 4, cls)).toBe("");
  });
});
