// @vitest-environment jsdom
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { AccountSheetProvider } from "./AccountSheet";
vi.mock("../ui/Dialog", () => ({
  Dialog: ({ closeLabel }: { closeLabel: string }) =>
    h("button", { "aria-label": closeLabel }),
}));
it("names the sheet close control without suggesting account deletion", () => {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(
    h(AccountSheetProvider, {
      email: null,
      name: null,
      image: null,
      owner: false,
      current: null,
      onSettings: vi.fn(),
      onSignIns: vi.fn(),
      onOwner: vi.fn(),
      onReports: vi.fn(),
      onSignOut: vi.fn(),
      children: null,
    })
  );
  expect(host.querySelector("button")?.getAttribute("aria-label")).toBe(
    "Close account menu"
  );
});
