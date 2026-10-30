import { expect, test } from "vitest";
import { FORMAT_NAMES, FORMATS, STANDING_WORDS } from "./catalogText";
import { formatLabel, statusOf, TARGET_FORMATS } from "../decks/targetFormat";
import { FORMAT_CHIPS, FORMAT_LABELS } from "../discover/discoverText";
import { legalityText } from "../owner/reprintValues";

// The Pokémon Formats' words wherever a collector or the owner reads them: the order, the short name on a chip or
// pill ("GLC") and the long name in a picker or sentence ("Gym Leader Challenge").

test("Catalog's format chips use the short names, Standard first", () => {
  expect(FORMATS).toEqual([
    { value: "standard", label: "Standard" },
    { value: "expanded", label: "Expanded" },
    { value: "glc", label: "GLC" },
  ]);
});

test("Catalog's legality-unknown labels use the long names", () => {
  expect(FORMAT_NAMES).toEqual({
    standard: "Standard",
    expanded: "Expanded",
    glc: "Gym Leader Challenge",
  });
});

test("a legality pill's standing words", () => {
  expect(STANDING_WORDS).toEqual({
    legal: "Legal",
    not_legal: "Not legal",
    unknown: "Unknown",
  });
});

test("the Target Format picker uses the long names, Standard first", () => {
  expect(TARGET_FORMATS).toEqual([
    { value: "standard", label: "Standard" },
    { value: "expanded", label: "Expanded" },
    { value: "glc", label: "Gym Leader Challenge" },
  ]);
  expect(formatLabel("glc")).toBe("Gym Leader Challenge");
  expect(formatLabel("standard")).toBe("Standard");
  expect(formatLabel("unlimited")).toBe("unlimited");
});

test("a format check's status reads as a mark, words and a tone", () => {
  expect(statusOf("legal")).toEqual({ mark: "✓", text: "Legal", tone: "ok" });
  expect(statusOf("not_legal")).toEqual({
    mark: "✕",
    text: "Not legal",
    tone: "bad",
  });
  expect(statusOf("unknown")).toEqual({
    mark: "?",
    text: "Unknown",
    tone: "unverified",
  });
});

test("Discover's format chips and deck cards use the short names", () => {
  expect(FORMAT_CHIPS).toEqual(["standard", "expanded", "glc"]);
  expect(FORMAT_LABELS).toEqual({
    standard: "Standard",
    expanded: "Expanded",
    glc: "GLC",
  });
});

test("a Reprint Group's legality reads with the short names, falling back to the server's name", () => {
  expect(
    legalityText([
      { format: "standard", name: "Standard", status: "legal" },
      { format: "expanded", name: "Expanded", status: "unknown" },
      { format: "glc", name: "Gym Leader Challenge", status: "not_legal" },
      { format: "unlimited", name: "Unlimited", status: "legal" },
    ])
  ).toBe(
    "Standard: Legal · Expanded: Unknown · GLC: Not legal · Unlimited: Legal"
  );
});
