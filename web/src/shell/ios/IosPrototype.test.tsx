// @vitest-environment jsdom
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RETURN_URL } from "./fixtureSession";

const native = vi.hoisted(() => ({
  receive: (_event: { url: string }) => {},
  launch: vi.fn(async (_options: { url: string }) => ({ completed: true })),
}));
vi.mock("@capacitor/app", () => ({
  App: {
    addListener: vi.fn(
      async (name: string, listener: typeof native.receive) => {
        if (name === "appUrlOpen") native.receive = listener;
        return { remove: vi.fn() };
      }
    ),
    getLaunchUrl: vi.fn(async () => undefined),
  },
}));
vi.mock("@capacitor/app-launcher", () => ({
  AppLauncher: { openUrl: native.launch },
}));
import { IosPrototype } from "./IosPrototype";

let root: Root;
let host: HTMLDivElement;
beforeEach(async () => {
  vi.useFakeTimers();
  // Node 26 exposes an unavailable global Storage that Vitest copies over jsdom.
  const storage = new JSDOM("", { url: "https://prototype.invalid" }).window
    .localStorage;
  vi.stubGlobal("localStorage", storage);
  Object.defineProperty(window, "localStorage", {
    value: storage,
    configurable: true,
  });
  native.launch.mockReset().mockResolvedValue({ completed: true });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<IosPrototype />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
async function click(label: string) {
  const button = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === label
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
}
async function complete() {
  await click("Sign in with browser");
  const url = native.launch.mock.calls[0][0].url;
  expect(new URL(url).origin).toBe("http://127.0.0.1:4319");
  const state = new URL(url).searchParams.get("state");
  await act(async () =>
    native.receive({ url: `${RETURN_URL}?state=${state}&result=success` })
  );
}
it("opens browser, shows Collection, recovers after remount and removes it on sign-out", async () => {
  await complete();
  expect(host.textContent).toContain("Pikachu");
  await act(async () => root.unmount());
  root = createRoot(host);
  await act(async () => root.render(<IosPrototype />));
  expect(host.textContent).toContain("Pikachu");
  await click("Sign out");
  expect(host.textContent).not.toContain("Pikachu");
  expect(host.textContent).toContain("Signed out.");
});
it("clears Collection at foreground session expiry", async () => {
  await complete();
  await act(async () => vi.advanceTimersByTime(30 * 60_000));
  expect(host.textContent).not.toContain("Pikachu");
  expect(host.textContent).toContain("Sign in with browser");
});
it("shows retry when browser launch fails and permits explicit cancellation", async () => {
  native.launch.mockRejectedValueOnce(new Error("unavailable"));
  await click("Sign in with browser");
  expect(host.textContent).toContain("Unable to open sign-in");
  await click("Sign in with browser");
  await click("Cancel sign-in");
  expect(host.textContent).toContain("Sign-in cancelled.");
  expect(host.textContent).not.toContain("Pikachu");
});
