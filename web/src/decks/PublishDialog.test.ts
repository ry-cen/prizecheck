// @vitest-environment jsdom
import { createElement as h, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { PublishDialog } from "./PublishDialog";
it("marks the empty title for initial focus and explains the publish requirement", () => {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(
    h(PublishDialog, {
      open: true,
      onClose: () => {},
      returnFocus: createRef<HTMLElement>(),
      deckId: "deck",
      publication: {
        kind: "ready",
        status: { token: null, version: null, title: null, visibility: null },
      },
      onReload: async () => {},
      blocked: null,
      onNotLegal: () => {},
    })
  );
  const input = host.querySelector("input")!;
  expect(input.hasAttribute("data-autofocus")).toBe(true);
  expect(input.value).toBe("");
  expect(document.activeElement).not.toBe(input);
  expect(
    host.querySelector("button[type=submit]")!.hasAttribute("disabled")
  ).toBe(true);
  const help = host.querySelector(
    `[id="${input.getAttribute("aria-describedby")}"]`
  );
  expect(help?.textContent).toBe("A public title is required to publish.");
});
