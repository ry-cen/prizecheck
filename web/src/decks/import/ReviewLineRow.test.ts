// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReviewLine } from "../../decks_generated";
import { ReviewLineRow } from "./ReviewLineRow";

// The resolver searches the catalog as it opens; nothing here needs an answer.
vi.mock("../../catalog_browse_generated", () => ({
  browseEditions: () => new Promise(() => undefined),
}));
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLElement;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const line = (status: ReviewLine["status"], extra: Partial<ReviewLine> = {}) =>
  ({
    line: 1,
    text: "1 Iono PAL 185",
    section: "trainer",
    quantity: "1",
    name: "Iono",
    set_code: "PAL",
    number: "185",
    ph: false,
    status,
    printing: null,
    candidates: [],
    editions: [],
    parts: [],
    kept: [],
    report: null,
    ...extra,
  }) as ReviewLine;

async function show(
  review: ReviewLine,
  locked: boolean,
  open: "fix" | "edition" | null = null
) {
  await act(async () =>
    root.render(
      h(ReviewLineRow, {
        line: review,
        open,
        locked,
        onToggle: () => undefined,
        onPick: () => undefined,
        onDrop: () => undefined,
        onRestore: () => undefined,
        onEdition: () => undefined,
        actionRef: () => undefined,
      })
    )
  );
}
const action = (name: string) =>
  [...host.querySelectorAll("button")].find(
    (each) => each.textContent === name
  );

it.each([
  ["not_found", "Fix"],
  ["matched", "Edition"],
  ["energy", "Change"],
  ["dropped", "Restore"],
] as const)(
  "a %s line's %s button is disabled while a save is in flight, and enabled again after",
  async (status, name) => {
    await show(line(status), false);
    expect(action(name)?.disabled).toBe(false);
    await show(line(status), true);
    expect(action(name)?.disabled).toBe(true);
    await show(line(status), false);
    expect(action(name)?.disabled).toBe(false);
  }
);

it("an open resolver is inside a disabled fieldset while a save is in flight, so Drop line can't be pressed", async () => {
  await show(line("not_found"), false, "fix");
  const dropLine = () => action("Drop line");
  expect(dropLine()?.closest("fieldset")?.disabled ?? false).toBe(false);
  expect(dropLine()?.matches(":disabled")).toBe(false);
  await show(line("not_found"), true, "fix");
  expect(dropLine()?.closest("fieldset")?.disabled).toBe(true);
  expect(dropLine()?.matches(":disabled")).toBe(true);
});
