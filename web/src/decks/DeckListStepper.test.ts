// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { DeckListStepper, EditFeedbackLine } from "./DeckListStepper";

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
  expect(remove!.getAttribute("aria-label")).toBe("−1, Remove one Tangela");
  expect(add!.getAttribute("aria-label")).toBe("+1, Add one Tangela");
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
    "button[aria-label='−1, Remove one Tangela']"
  );
  expect(remove!.disabled).toBe(true);
});

test("the count is not a live region, so an edit is announced once, by its own message", () => {
  root = createRoot(host);
  act(() =>
    root.render(
      createElement(DeckListStepper, {
        cardName: "Tangela",
        quantity: 3n,
        onChange: vi.fn(),
      })
    )
  );
  expect(host.querySelector("[aria-live], output, [role='status']")).toBeNull();
  act(() => root.unmount());
  root = createRoot(host);
  act(() =>
    root.render(
      createElement(EditFeedbackLine, {
        feedback: {
          id: 2,
          message: "Added 1 Tangela.",
          undo: null,
          busy: false,
        },
        since: 1,
      })
    )
  );
  const lines = host.querySelectorAll("[role='status']");
  expect(lines).toHaveLength(1);
  expect(lines[0].textContent).toBe("Added 1 Tangela.");
  expect(lines[0].hasAttribute("data-edit-feedback")).toBe(true);
});

test("an unconfirmed change is marked beside the count, outside the count's words", () => {
  root = createRoot(host);
  act(() =>
    root.render(
      createElement(DeckListStepper, {
        cardName: "Tangela",
        quantity: 3n,
        unconfirmed: 1n,
        onChange: vi.fn(),
      })
    )
  );
  const count = host.querySelector("strong")!.parentElement!;
  expect(count.textContent).toBe("3 on Deck List");
  expect(host.textContent).toContain("+1 not confirmed");
  expect(count.textContent).not.toContain("not confirmed");
  act(() =>
    root.render(
      createElement(DeckListStepper, {
        cardName: "Tangela",
        quantity: 3n,
        unconfirmed: -2n,
        onChange: vi.fn(),
      })
    )
  );
  expect(host.textContent).toContain("−2 not confirmed");
  act(() =>
    root.render(
      createElement(DeckListStepper, {
        cardName: "Tangela",
        quantity: 3n,
        onChange: vi.fn(),
      })
    )
  );
  expect(host.textContent).not.toContain("not confirmed");
});
