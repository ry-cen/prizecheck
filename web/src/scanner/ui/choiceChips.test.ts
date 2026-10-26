import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChoiceChips } from "../../ui/Chip";

const options = [
  { value: "a", label: "Normal" },
  { value: "b", label: "Reverse Holo" },
];
const html = (value: string | null) =>
  renderToStaticMarkup(
    createElement(ChoiceChips, {
      label: "Finish",
      options,
      value,
      onChange: () => {},
    })
  );

describe("ChoiceChips", () => {
  it("presses exactly the chosen chip", () => {
    const out = html("b");
    expect(out.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(out).toMatch(
      /aria-pressed="true"[^>]*>(?:(?!<button).)*Reverse Holo/
    );
  });

  it("presses none while no finish is chosen", () => {
    expect(html(null)).not.toContain('aria-pressed="true"');
  });

  it("is a named group", () => {
    expect(html("a")).toContain('role="group" aria-label="Finish"');
  });
});
