// @vitest-environment jsdom
import type React from "react";
import { expect, it } from "vitest";
import { isPlainClick } from "./appLink";

function click(
  overrides: Partial<React.MouseEvent<HTMLAnchorElement>> = {},
  target = ""
) {
  const anchor = document.createElement("a");
  anchor.target = target;
  return {
    defaultPrevented: false,
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    currentTarget: anchor,
    ...overrides,
  } as React.MouseEvent<HTMLAnchorElement>;
}
it("accepts a plain left click with no target or _self", () => {
  expect(isPlainClick(click())).toBe(true);
  expect(isPlainClick(click({}, "_self"))).toBe(true);
});
it.each([
  "metaKey",
  "ctrlKey",
  "shiftKey",
  "altKey",
  "defaultPrevented",
] as const)("passes %s through", (key) => {
  expect(isPlainClick(click({ [key]: true }))).toBe(false);
});
it("passes middle clicks and other targets through", () => {
  expect(isPlainClick(click({ button: 1 }))).toBe(false);
  expect(isPlainClick(click({}, "_blank"))).toBe(false);
  expect(isPlainClick(click({}, "named"))).toBe(false);
});
