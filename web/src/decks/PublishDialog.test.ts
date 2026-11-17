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
  expect(help?.textContent).toBe(
    "The name shown on the Published Deck. You need one to publish."
  );
});

function markup(token: string | null) {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(
    h(PublishDialog, {
      open: true,
      onClose: () => {},
      returnFocus: createRef<HTMLElement>(),
      deckId: "deck",
      publication: {
        kind: "ready",
        status: token
          ? { token, version: 1, title: "Mine", visibility: "unlisted" }
          : { token: null, version: null, title: null, visibility: null },
      },
      onReload: async () => {},
      blocked: null,
      onNotLegal: () => {},
    })
  );
  return host;
}
const names = (host: HTMLElement) =>
  [...host.querySelectorAll("a, button")].map((el) => el.textContent?.trim());

it("offers Copy link beside View public snapshot once published, and not before", () => {
  expect(names(markup("tok"))).toEqual(
    expect.arrayContaining(["View public snapshot", "Copy link"])
  );
  expect(names(markup(null))).not.toContain("Copy link");
  expect(names(markup(null))).not.toContain("View public snapshot");
});
