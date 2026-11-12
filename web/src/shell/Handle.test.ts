// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { setHandle } from "../profile_generated";
import { PrivacySection } from "../settings/PrivacySection";
vi.mock("../profile_generated", async (original) => ({
  ...(await original<typeof import("../profile_generated")>()),
  setHandle: vi.fn(async ({ handle }: { handle: string }) => ({
    display_name: "Jordan",
    handle: handle.trim(),
    invite_token: "token",
    handle_change_available_at: null,
  })),
  getProfile: async () => ({
    display_name: "Jordan",
    handle: "jordan",
    invite_token: "token",
  }),
}));
it.each(["valid_handle", "  MistyW  "])(
  "focuses and describes a refused Handle, then accepts %s",
  async (corrected) => {
    vi.mocked(setHandle).mockClear();
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
      await edit(input, corrected);
      expect(input.hasAttribute("aria-invalid")).toBe(false);
      expect(host.querySelector('[role="alert"]')).toBeNull();
      await act(async () => {
        input
          .closest("form")!
          .dispatchEvent(
            new Event("submit", { bubbles: true, cancelable: true })
          );
      });
      expect(setHandle).toHaveBeenCalledWith({
        handle: corrected,
        idempotency_key: expect.any(String),
      });
      expect(input.value).toBe(corrected.trim());
    } finally {
      await act(async () => root.unmount());
      host.remove();
      vi.unstubAllGlobals();
    }
  }
);
