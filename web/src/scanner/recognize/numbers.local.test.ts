import { describe, expect, it } from "vitest";
import { hasLocal, LOCAL, readJson } from "../fixtures/read";
import { checkParseCorpus } from "../fixtures/recognizeUtil";
import type { Known, ParseEntry } from "../fixtures/recognizeUtil";
import { parseNumberText } from "./numbers";

describe.skipIf(!hasLocal())(
  "parseNumberText on real-photo OCR text (local)",
  () => {
    it("ASCII exact, non-ASCII within 5%, Python errors never throw", () => {
      const { known, parse } = readJson<{ known: Known; parse: ParseEntry[] }>(
        "parse-real.json",
        LOCAL
      );
      const r = checkParseCorpus(parse, known, parseNumberText, "parse-real");
      expect(r.asciiMismatch).toEqual([]);
      expect(r.throws).toEqual([]);
      expect(r.nonAsciiMismatch.length).toBeLessThanOrEqual(0.05 * r.nonAscii);
    });
  }
);
