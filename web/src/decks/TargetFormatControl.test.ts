// @vitest-environment jsdom
import { act, createElement, createRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import type { FormatCheck } from "../format_checks_generated";
import { TargetFormatControl } from "./TargetFormatControl";
import type { TargetFormat } from "./targetFormat";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const host = document.createElement("div");
document.body.append(host);
let root: ReturnType<typeof createRoot>;
afterEach(() => {
  act(() => root.unmount());
});

const check = (
  status: FormatCheck["status"],
  issues: number,
  format = "standard"
): FormatCheck =>
  ({
    format,
    status,
    issues: Array.from({ length: issues }, () => ({})),
  }) as unknown as FormatCheck;

function render(props: {
  value?: TargetFormat;
  result: FormatCheck | null;
  busy?: boolean;
}) {
  act(() =>
    root.render(
      createElement(TargetFormatControl, {
        value: props.value ?? "standard",
        result: props.result,
        busy: props.busy ?? false,
        onChange: vi.fn(),
        onOpenResult: vi.fn(),
        resultRef: createRef<HTMLButtonElement>(),
      })
    )
  );
}

/** Watches the status line the way a screen reader does: it hears what is added to it. */
function listen() {
  const line = host.querySelector("[role='status']")!;
  const heard: string[] = [];
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "characterData")
        heard.push(record.target.textContent ?? "");
      else
        record.addedNodes.forEach((node) => heard.push(node.textContent ?? ""));
    }
  });
  observer.observe(line, {
    childList: true,
    characterData: true,
    subtree: true,
  });
  return {
    line,
    stop: () => {
      observer.takeRecords().forEach(() => {});
      observer.disconnect();
    },
    heard,
  };
}
const flush = () => Promise.resolve();

test("a Deck List edit on its way doesn't blank or redraw the status line", async () => {
  root = createRoot(host);
  render({ result: check("not_legal", 3) });
  const { line, heard, stop } = listen();
  expect(line.textContent).toBe("Standard: Not legal");
  // The page marks the control busy while an edit is sent, then settles with the same result.
  render({ result: check("not_legal", 3), busy: true });
  expect(line.textContent).toBe("Standard: Not legal");
  render({ result: check("not_legal", 3), busy: false });
  await flush();
  stop();
  expect(heard).toEqual([]);
  expect(line.textContent).toBe("Standard: Not legal");
});

test("an edit that only changes the issue count says nothing, and the button still names the current count", async () => {
  root = createRoot(host);
  render({ result: check("not_legal", 3) });
  const { line, heard, stop } = listen();
  render({ result: check("not_legal", 2), busy: true });
  render({ result: check("not_legal", 2), busy: false });
  await flush();
  stop();
  expect(heard).toEqual([]);
  expect(line.textContent).toBe("Standard: Not legal");
  expect(
    host
      .querySelector("button[aria-label$='result']")!
      .getAttribute("aria-label")
  ).toBe("Not legal, 2 issues. Show the Standard result");
});

/** Every string the control exposes: its text, and its names, labels and titles. */
function exposed() {
  return [
    host.textContent ?? "",
    ...[...host.querySelectorAll("[aria-label], [title]")].flatMap((el) => [
      el.getAttribute("aria-label") ?? "",
      el.getAttribute("title") ?? "",
    ]),
  ].join("\n");
}

test("after an edit that only changes the count, no exposed text still shows the old count", async () => {
  root = createRoot(host);
  render({ result: check("not_legal", 3) });
  expect(exposed()).toContain("3 issues");
  render({ result: check("not_legal", 2), busy: true });
  render({ result: check("not_legal", 2), busy: false });
  await flush();
  const text = exposed();
  expect(text).not.toContain("3 issues");
  expect(text).toContain("2 issues");
  // The count is said once, by the result button; the status line has no number to go out of date.
  expect(text.match(/\d+ issues?/g)).toHaveLength(1);
  expect(host.querySelector("[role='status']")!.textContent).not.toMatch(/\d/);
  render({ result: check("not_legal", 1), busy: false });
  await flush();
  expect(exposed()).not.toMatch(/[23] issues/);
  expect(exposed()).toContain("1 issue");
});

test("an edit that changes the Deck's standing says the new standing once", async () => {
  root = createRoot(host);
  render({ result: check("not_legal", 1) });
  const { line, heard, stop } = listen();
  render({ result: check("not_legal", 1), busy: true });
  render({ result: check("legal", 0), busy: true });
  render({ result: check("legal", 0), busy: false });
  await flush();
  stop();
  expect(heard).toEqual(["Standard: Legal"]);
  expect(line.textContent).toBe("Standard: Legal");
});

test("a deliberate Target Format change says its result once, after it settles", async () => {
  root = createRoot(host);
  render({ result: check("legal", 0) });
  const { line, heard, stop } = listen();
  // The change is on its way: no result yet, and the line keeps what it said.
  render({ value: "expanded", result: null, busy: true });
  expect(line.textContent).toBe("Standard: Legal");
  render({
    value: "expanded",
    result: check("not_legal", 2, "expanded"),
    busy: false,
  });
  await flush();
  stop();
  expect(heard).toEqual(["Expanded: Not legal"]);
});

test("changing Format and back says each result", async () => {
  root = createRoot(host);
  render({ result: check("legal", 0) });
  const { heard, stop } = listen();
  render({ value: "expanded", result: null, busy: true });
  render({ value: "expanded", result: check("legal", 0, "expanded") });
  await flush();
  render({ value: "standard", result: null, busy: true });
  render({ value: "standard", result: check("legal", 0) });
  await flush();
  stop();
  expect(heard).toEqual(["Expanded: Legal", "Standard: Legal"]);
});
