// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { PrivacySection } from "../settings/PrivacySection";
vi.mock("../profile_generated", async (original) => ({
  ...(await original<typeof import("../profile_generated")>()),
  getProfile: async () => ({
    display_name: "Jordan",
    handle: "jordan",
    invite_token: "token",
  }),
}));
it("focuses and describes a refused Handle and clears validation when corrected", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const edit = async (input: HTMLInputElement, value: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  try {
    await act(async () => root.render(h(PrivacySection)));
    const input = host.querySelector<HTMLInputElement>(
      'input[autocomplete="username"]'
    )!;
    await edit(input, "a!");
    input.closest("form")!.querySelector("button")!.focus();
    await act(async () => {
      input
        .closest("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true })
        );
    });
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(input);
    const error = host.querySelector('[role="alert"]')!;
    expect(error.textContent).toBe(
      "Use 3 to 20 letters, digits and underscores."
    );
    expect(input.getAttribute("aria-describedby")!.split(" ")).toContain(
      error.id
    );
    await edit(input, "valid_handle");
    expect(input.hasAttribute("aria-invalid")).toBe(false);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
