// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { DeckListStepper } from "./DeckListStepper";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const host = document.createElement("div");
document.body.append(host);
let root: ReturnType<typeof createRoot>;
afterEach(() => {
  act(() => root.unmount());
});

test("the stepper's buttons are named for the card, and still show −1 and +1", () => {
  root = createRoot(host);
  const onChange = vi.fn();
  act(() =>
    root.render(
      createElement(DeckListStepper, {
        cardName: "Tangela",
        quantity: 2n,
        onChange,
      })
    )
  );
  const [remove, add] = [...host.querySelectorAll("button")];
  expect(remove!.getAttribute("aria-label")).toBe("Remove one Tangela");
  expect(add!.getAttribute("aria-label")).toBe("Add one Tangela");
  expect(remove!.textContent).toBe("−1");
  expect(add!.textContent).toBe("+1");
  act(() => remove!.click());
  act(() => add!.click());
  expect(onChange.mock.calls).toEqual([[-1n], [1n]]);
});

test("Remove one is disabled when the card is not on the Deck List", () => {
  root = createRoot(host);
  act(() =>
    root.render(
      createElement(DeckListStepper, {
        cardName: "Tangela",
        quantity: 0n,
        onChange: vi.fn(),
      })
    )
  );
  const remove = host.querySelector<HTMLButtonElement>(
    "button[aria-label='Remove one Tangela']"
  );
  expect(remove!.disabled).toBe(true);
});
