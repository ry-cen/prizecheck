// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { PrivacySection } from "../settings/PrivacySection";
vi.mock("../profile_generated", async (original) => ({
  ...(await original<typeof import("../profile_generated")>()),
  setDisplayName: vi.fn().mockRejectedValue(new Error("Invalid name")),
  getProfile: async () => ({
    display_name: "Jordan",
    handle: "jordan",
    invite_token: "token",
  }),
}));
it("focuses and describes an invalid name, then clears the message when corrected", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(h(PrivacySection)));
    const input = host.querySelector<HTMLInputElement>(
      'input[autocomplete="nickname"]'
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )!.set!.call(input, "");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      input
        .closest("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    );
    expect(document.activeElement).toBe(input);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(
      document.getElementById(
        input.getAttribute("aria-describedby")!.split(" ").at(-1)!
      )?.textContent
    ).toBe("Enter a name of 1 to 40 characters.");
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )!.set!.call(input, "Sam");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(input.getAttribute("aria-invalid")).not.toBe("true");
    expect(host.textContent).not.toContain("Enter a name");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
