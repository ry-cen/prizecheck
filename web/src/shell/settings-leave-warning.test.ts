// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { OpenDiscoverySection } from "../settings/OpenDiscoverySection";
import { setDiscovery } from "../social_generated";
import {
  setDisplayName,
  setHandle,
  type CollectorProfile,
} from "../profile_generated";
import { PrivacySection } from "../settings/PrivacySection";
vi.mock("../profile_generated", async (original) => ({
  ...(await original<typeof import("../profile_generated")>()),
  setDisplayName: vi.fn(),
  setHandle: vi.fn(),
  getProfile: async () => ({
    display_name: "Jordan",
    handle: "jordan",
    invite_token: "token",
  }),
}));
it("reports dirty name and Handle, and clears reverted or discarded drafts", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const changed = vi.fn();
  try {
    await act(async () =>
      root.render(
        h(PrivacySection, { onDirtyChange: changed, discardVersion: 0 })
      )
    );
    expect(changed).toHaveBeenLastCalledWith(false);
    for (const autocomplete of ["nickname", "username"]) {
      const input = host.querySelector<HTMLInputElement>(
        `input[autocomplete="${autocomplete}"]`
      )!;
      const saved = input.value;
      const edit = async (value: string) =>
        act(async () => {
          Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            "value"
          )!.set!.call(input, value);
          input.dispatchEvent(new Event("input", { bubbles: true }));
        });
      await edit("changed");
      expect(changed).toHaveBeenLastCalledWith(true);
      await edit(saved);
      expect(changed).toHaveBeenLastCalledWith(false);
    }
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

vi.mock("../social_generated", async (original) => ({
  ...(await original<typeof import("../social_generated")>()),
  getDiscovery: async () => ({
    status: "off",
    zip: "10001",
    zip_changes_left: 3,
  }),
  setDiscovery: vi.fn(),
}));

for (const field of ["name", "handle", "zip"] as const) {
  for (const outcome of [
    "newer edit",
    "discard",
    "edit after discard",
    "failed discarded save",
  ] as const) {
    it(`${field}: pending save handles ${outcome}`, async () => {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      const changed = vi.fn();
      let complete!: () => void;
      let fail!: () => void;
      if (field === "zip") {
        vi.mocked(setDiscovery).mockImplementation(
          () =>
            new Promise((resolve, reject) => {
              fail = () => reject(new Error("Save failed"));
              complete = () =>
                resolve({
                  status: "off",
                  zip: "10002",
                  zip_changes_left: 2,
                  radius_mi: 5,
                  visible_beyond_friends: false,
                });
            })
        );
      } else {
        const mock =
          field === "name" ? vi.mocked(setDisplayName) : vi.mocked(setHandle);
        mock.mockImplementation(
          () =>
            new Promise<CollectorProfile>((resolve, reject) => {
              fail = () => reject(new Error("Save failed"));
              complete = () =>
                resolve({
                  display_name: field === "name" ? "changed" : "Jordan",
                  handle: field === "handle" ? "changed" : "jordan",
                  invite_token: "token",
                  handle_change_available_at: null,
                });
            })
        );
      }
      try {
        await act(async () =>
          root.render(
            field === "zip"
              ? h(OpenDiscoverySection, { onDirtyChange: changed })
              : h(PrivacySection, { onDirtyChange: changed })
          )
        );
        expect(changed).toHaveBeenLastCalledWith(false);
        const input = host.querySelector<HTMLInputElement>(
          field === "zip"
            ? 'input[autocomplete="postal-code"]'
            : `input[autocomplete="${field === "name" ? "nickname" : "username"}"]`
        )!;
        const original = input.value;
        const edit = async (value: string) =>
          act(async () => {
            Object.getOwnPropertyDescriptor(
              HTMLInputElement.prototype,
              "value"
            )!.set!.call(input, value);
            input.dispatchEvent(new Event("input", { bubbles: true }));
          });
        await edit(field === "zip" ? "10002" : "changed");
        expect(changed).toHaveBeenLastCalledWith(true);
        await act(async () =>
          input
            .closest("form")!
            .dispatchEvent(
              new Event("submit", { bubbles: true, cancelable: true })
            )
        );
        if (outcome !== "newer edit") {
          await act(async () =>
            root.render(
              field === "zip"
                ? h(OpenDiscoverySection, {
                    onDirtyChange: changed,
                    discardVersion: 1,
                  })
                : h(PrivacySection, {
                    onDirtyChange: changed,
                    discardVersion: 1,
                  })
            )
          );
          expect(input.value).toBe(original);
          expect(changed).toHaveBeenLastCalledWith(false);
          if (outcome === "failed discarded save") {
            await act(async () => fail());
            expect(input.value).toBe(original);
            expect(changed).toHaveBeenLastCalledWith(false);
            return;
          }
          if (outcome === "discard") {
            await act(async () => complete());
            expect(input.value).toBe(field === "zip" ? "10002" : "changed");
            expect(
              input.closest("form")!.querySelector("button")!.disabled
            ).toBe(true);
            expect(changed).toHaveBeenLastCalledWith(false);
            return;
          }
        } else await edit(original);
        if (outcome === "newer edit")
          expect(changed).toHaveBeenLastCalledWith(true);
        await edit(field === "zip" ? "10003" : "newer");
        await act(async () => complete());
        expect(input.value).toBe(field === "zip" ? "10003" : "newer");
        expect(changed).toHaveBeenLastCalledWith(true);
        await edit(field === "zip" ? "10002" : "changed");
        expect(changed).toHaveBeenLastCalledWith(false);
      } finally {
        await act(async () => root.unmount());
        host.remove();
        vi.unstubAllGlobals();
      }
    });
  }
}
