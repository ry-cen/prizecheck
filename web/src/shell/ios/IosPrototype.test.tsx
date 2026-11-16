// @vitest-environment jsdom
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FixtureSession, RETURN_URL } from "./fixtureSession";
import type { CollectionPage } from "../../collection_generated";
import type { CollectionRead, CollectionSource } from "./collectionSource";

const native = vi.hoisted(() => ({
  receive: (_event: { url: string }) => {},
  active: (_event: { isActive: boolean }) => {},
  launchUrl: vi.fn(async (): Promise<{ url: string } | undefined> => undefined),
  launch: vi.fn(async (_options: { url: string }) => ({ completed: true })),
}));
vi.mock("@capacitor/app", () => ({
  App: {
    addListener: vi.fn(
      async (
        name: string,
        listener: (event: { url?: string; isActive?: boolean }) => void
      ) => {
        if (name === "appUrlOpen") native.receive = (event) => listener(event);
        if (name === "appStateChange")
          native.active = (event) => listener(event);
        return { remove: vi.fn() };
      }
    ),
    getLaunchUrl: native.launchUrl,
  },
}));
vi.mock("@capacitor/app-launcher", () => ({
  AppLauncher: { openUrl: native.launch },
}));
import { IosPrototype } from "./IosPrototype";

function entry(name: string) {
  return {
    edition_id: `e-${name}`,
    quantity: "1",
    printing_id: `p-${name}`,
    printing_name: name,
    set_id: "s",
    set_name: "Demo set",
    collector_number: "1",
    descriptor: {},
    image_url: null,
  };
}
function pageOf(names: string[], next: string | null = null): CollectionPage {
  return {
    entries: names.map(entry),
    owner_revision: 1,
    catalog_revision: 1,
    next_cursor: next,
  };
}
const ok = (page: CollectionPage): CollectionRead => ({ kind: "page", page });
function deferred() {
  let resolve!: (value: CollectionRead) => void;
  const promise = new Promise<CollectionRead>((done) => (resolve = done));
  return { promise, resolve };
}
function scripted(read: CollectionSource["read"]) {
  return { sample: true, read: vi.fn(read) } satisfies CollectionSource;
}
async function mountWith(source: CollectionSource) {
  await act(async () => root.unmount());
  root = createRoot(host);
  await act(async () => root.render(<IosPrototype source={source} />));
  await complete();
}

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
  native.launchUrl.mockReset().mockResolvedValue(undefined);
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
  expect(host.textContent).toContain("Demo with sample cards");
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

it("consumes a persisted browser attempt from getLaunchUrl on cold startup", async () => {
  await act(async () => root.unmount());
  const pending = new FixtureSession(window.localStorage);
  const state = new URL(pending.begin()).searchParams.get("state");
  native.launchUrl.mockResolvedValueOnce({
    url: `${RETURN_URL}?state=${state}&result=success`,
  });
  root = createRoot(host);
  await act(async () => root.render(<IosPrototype />));
  expect(host.textContent).toContain("Pikachu");
  expect(host.textContent).toContain("Sign out");
});
it("clears an expired Collection on appStateChange without advancing the polling timer", async () => {
  await complete();
  vi.setSystemTime(Date.now() + 30 * 60_000);
  await act(async () => native.active({ isActive: true }));
  expect(host.textContent).not.toContain("Pikachu");
  expect(host.textContent).toContain("Sign in with browser");
});

it("shows loading, then the empty message", async () => {
  const wait = deferred();
  await mountWith(scripted(() => wait.promise));
  expect(host.textContent).toContain("Loading your Collection…");
  await act(async () => wait.resolve(ok(pageOf([]))));
  expect(host.textContent).not.toContain("Loading your Collection…");
  expect(host.textContent).toContain("No cards in your Collection yet.");
});
it("offers Try again after a failed first read", async () => {
  const reads: CollectionRead[] = [
    { kind: "unavailable" },
    ok(pageOf(["Mew"])),
  ];
  await mountWith(scripted(async () => reads.shift()!));
  expect(host.textContent).toContain(
    "Couldn't load your Collection. Try again."
  );
  await click("Try again");
  expect(host.textContent).toContain("Mew");
  expect(host.textContent).not.toContain("Couldn't load");
});
it("appends on Show more and keeps the list when it fails", async () => {
  const source = scripted(async (cursor) =>
    !cursor
      ? ok(pageOf(["Mew"], "c2"))
      : source.read.mock.calls.length === 2
        ? { kind: "unavailable" }
        : ok(pageOf(["Eevee"]))
  );
  await mountWith(source);
  const wait = deferred();
  source.read.mockImplementationOnce(() => wait.promise);
  await click("Show more");
  const busy = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Loading…"
  );
  expect(busy?.disabled).toBe(true);
  await act(async () => wait.resolve({ kind: "unavailable" }));
  expect(host.textContent).toContain("Mew");
  expect(host.textContent).toContain("Couldn't load your Collection");
  await click("Try again");
  expect(host.textContent).toContain("Mew");
  expect(host.textContent).toContain("Eevee");
  expect(host.textContent).not.toContain("Show more");
});
it("replaces the list on Refresh and keeps it when Refresh fails", async () => {
  const reads: CollectionRead[] = [
    ok(pageOf(["Mew"])),
    ok(pageOf(["Eevee"])),
    { kind: "unavailable" },
  ];
  await mountWith(scripted(async () => reads.shift()!));
  await click("Refresh");
  expect(host.textContent).toContain("Eevee");
  expect(host.textContent).not.toContain("Mew");
  await click("Refresh");
  expect(host.textContent).toContain("Eevee");
  expect(host.textContent).toContain("Couldn't load your Collection");
});
it("keeps the list and says Refreshing… while a refresh is pending", async () => {
  const source = scripted(async () => ok(pageOf(["Mew"])));
  await mountWith(source);
  const wait = deferred();
  source.read.mockImplementationOnce(() => wait.promise);
  await click("Refresh");
  expect(host.textContent).toContain("Refreshing…");
  expect(host.textContent).toContain("Mew");
  await act(async () => wait.resolve(ok(pageOf(["Eevee"]))));
  expect(host.textContent).not.toContain("Refreshing…");
});
it("shows the session-ended message on a signed-out read", async () => {
  await mountWith(scripted(async () => ({ kind: "signed-out" })));
  expect(host.textContent).toContain("Your session ended. Sign in again.");
  expect(host.textContent).toContain("Sign in with browser");
  expect(new FixtureSession(window.localStorage).signedIn()).toBe(false);
});
it("ignores a late result after sign-out", async () => {
  const wait = deferred();
  await mountWith(scripted(() => wait.promise));
  await click("Sign out");
  await act(async () => wait.resolve(ok(pageOf(["Mew"]))));
  expect(host.textContent).not.toContain("Mew");
  expect(host.textContent).toContain("Signed out.");
});
it("says the session ended when it expires in the foreground", async () => {
  await mountWith(scripted(async () => ok(pageOf(["Mew"]))));
  await act(async () => vi.advanceTimersByTime(30 * 60_000));
  expect(host.textContent).not.toContain("Mew");
  expect(host.textContent).toContain("Your session ended. Sign in again.");
});
it("says the session ended when a read resolves after expiry but before any tick", async () => {
  const wait = deferred();
  await mountWith(scripted(() => wait.promise));
  vi.setSystemTime(Date.now() + 30 * 60_000);
  await act(async () => wait.resolve(ok(pageOf(["Mew"]))));
  expect(host.textContent).not.toContain("Mew");
  expect(host.textContent).toContain("Your session ended. Sign in again.");
  expect(host.textContent).toContain("Sign in with browser");
});
it("shows Signed out., not the ended message, for Sign out during a pending read", async () => {
  const wait = deferred();
  await mountWith(scripted(() => wait.promise));
  await click("Sign out");
  await act(async () => vi.advanceTimersByTime(2000));
  expect(host.textContent).toContain("Signed out.");
  expect(host.textContent).not.toContain("Your session ended.");
});
it("shows no message on a cold start while signed out", async () => {
  await act(async () => vi.advanceTimersByTime(2000));
  expect(host.textContent).toContain("Sign in with browser");
  expect(host.textContent).not.toContain("Your session ended.");
  expect(host.textContent).not.toContain("Signed out.");
});

// Native mode: the gateway is configured and the plugin holds the credential.
import type { NativeSignInPlugin } from "./nativeSignIn";
function fakePlugin(
  status: { configured: boolean; signedIn: boolean },
  overrides: Partial<NativeSignInPlugin> = {}
) {
  return {
    status: vi.fn(async () => status),
    signIn: vi.fn(async () => ({ result: "signed-in" as const })),
    collection: vi.fn(async () => ({
      kind: "page" as const,
      page: pageOf(["Bulbasaur"]),
    })),
    signOut: vi.fn(async () => {}),
    ...overrides,
  } satisfies NativeSignInPlugin;
}
async function mountNative(plugin: NativeSignInPlugin) {
  await act(async () => root.unmount());
  root = createRoot(host);
  await act(async () => root.render(<IosPrototype plugin={plugin} />));
}
it("keeps the fixture demo when the plugin says it is not configured", async () => {
  await mountNative(fakePlugin({ configured: false, signedIn: false }));
  expect(host.textContent).toContain("Demo with sample cards");
  expect(host.textContent).toContain("Sign in with browser");
});
it("keeps the fixture demo when the plugin call fails, as in a web build", async () => {
  await mountNative(
    fakePlugin(
      { configured: true, signedIn: false },
      {
        status: () => {
          throw new Error("not implemented");
        },
      }
    )
  );
  expect(host.textContent).toContain("Sign in with browser");
});
it("shows nothing but the shell until status resolves", async () => {
  let release!: (value: { configured: boolean; signedIn: boolean }) => void;
  const plugin = fakePlugin(
    { configured: true, signedIn: false },
    {
      status: () =>
        new Promise((done) => {
          release = done;
        }),
    }
  );
  await mountNative(plugin);
  expect(host.textContent).toBe("");
  await act(async () => release({ configured: true, signedIn: false }));
  expect(host.textContent).toContain("Sign in to see your Collection.");
});
it("signs in natively, shows the Collection and signs out", async () => {
  const plugin = fakePlugin({ configured: true, signedIn: false });
  await mountNative(plugin);
  expect(host.textContent).toContain("Prizecheck");
  expect(host.textContent).not.toContain("Demo with sample cards");
  expect(host.textContent).toContain("Sign in to see your Collection.");
  await click("Sign in");
  expect(plugin.signIn).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain("Bulbasaur");
  await click("Sign out");
  expect(plugin.signOut).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain("Signed out.");
  expect(host.textContent).not.toContain("Bulbasaur");
  expect(host.textContent).toContain("Sign in to see your Collection.");
});
it("restores a signed-in session from status", async () => {
  await mountNative(fakePlugin({ configured: true, signedIn: true }));
  expect(host.textContent).toContain("Bulbasaur");
  expect(host.textContent).toContain("Sign out");
});
it("says so when sign-in is cancelled or fails, and allows another try", async () => {
  const results = ["cancelled", "error", "signed-in"] as const;
  let calls = 0;
  const plugin = fakePlugin(
    { configured: true, signedIn: false },
    { signIn: vi.fn(async () => ({ result: results[calls++] })) }
  );
  await mountNative(plugin);
  await click("Sign in");
  expect(host.textContent).toContain("Sign-in cancelled.");
  await click("Sign in");
  expect(host.textContent).toContain("Unable to sign in. Please try again.");
  await click("Sign in");
  expect(host.textContent).toContain("Bulbasaur");
  expect(host.textContent).not.toContain("Unable to sign in");
});
it("treats a thrown sign-in as a failure", async () => {
  await mountNative(
    fakePlugin(
      { configured: true, signedIn: false },
      { signIn: () => Promise.reject(new Error("x")) }
    )
  );
  await click("Sign in");
  expect(host.textContent).toContain("Unable to sign in. Please try again.");
});
it("shows the session-ended message when a read is signed out", async () => {
  await mountNative(
    fakePlugin(
      { configured: true, signedIn: true },
      { collection: async () => ({ kind: "signed-out" as const }) }
    )
  );
  expect(host.textContent).toContain("Your session ended. Sign in again.");
  expect(host.textContent).toContain("Sign in to see your Collection.");
});
it("offers Try again, and Show more and Refresh, in native mode", async () => {
  const reads = [
    { kind: "unavailable" as const },
    { kind: "page" as const, page: pageOf(["Bulbasaur", "Charmander"], "c2") },
    { kind: "page" as const, page: pageOf(["Squirtle"]) },
    { kind: "page" as const, page: pageOf(["Bulbasaur"]) },
  ];
  const plugin = fakePlugin(
    { configured: true, signedIn: true },
    { collection: vi.fn(async () => reads.shift()!) }
  );
  await mountNative(plugin);
  expect(host.textContent).toContain("Couldn't load your Collection.");
  await click("Try again");
  expect(host.textContent).toContain("Charmander");
  await click("Show more");
  expect(plugin.collection).toHaveBeenLastCalledWith({ cursor: "c2" });
  expect(host.textContent).toContain("Squirtle");
  await click("Refresh");
  expect(host.textContent).not.toContain("Squirtle");
  expect(host.textContent).toContain("Bulbasaur");
});
