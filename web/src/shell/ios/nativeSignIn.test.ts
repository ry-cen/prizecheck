import { describe, expect, it, vi } from "vitest";
import {
  nativeCollectionSource,
  nativeStatus,
  type NativeSignInPlugin,
} from "./nativeSignIn";

function plugin(overrides: Partial<NativeSignInPlugin> = {}) {
  return {
    status: vi.fn(async () => ({ configured: true, signedIn: false })),
    signIn: vi.fn(async () => ({ result: "signed-in" as const })),
    collection: vi.fn(async () => ({ kind: "unavailable" as const })),
    signOut: vi.fn(async () => {}),
    ...overrides,
  } satisfies NativeSignInPlugin;
}
const page = {
  entries: [],
  owner_revision: 1,
  catalog_revision: 1,
  next_cursor: null,
};

describe("nativeStatus", () => {
  it("passes a configured status through", async () => {
    expect(await nativeStatus(plugin())).toEqual({
      configured: true,
      signedIn: false,
    });
  });
  it("reports not configured when the plugin throws or rejects", async () => {
    expect(
      await nativeStatus(
        plugin({
          status: () => {
            throw new Error("not implemented");
          },
        })
      )
    ).toEqual({ configured: false, signedIn: false });
    expect(
      await nativeStatus(
        plugin({ status: () => Promise.reject(new Error("x")) })
      )
    ).toEqual({ configured: false, signedIn: false });
  });
  it("treats a malformed status as not configured", async () => {
    expect(
      await nativeStatus(
        plugin({
          status: async () =>
            ({}) as { configured: boolean; signedIn: boolean },
        })
      )
    ).toEqual({ configured: false, signedIn: false });
  });
});

describe("nativeCollectionSource", () => {
  it("is not sample data", () => {
    expect(nativeCollectionSource(plugin()).sample).toBe(false);
  });
  it("returns a page, and passes the cursor only when there is one", async () => {
    const native = plugin({
      collection: vi.fn(async () => ({ kind: "page" as const, page })),
    });
    const source = nativeCollectionSource(native);
    expect(await source.read()).toEqual({ kind: "page", page });
    expect(native.collection).toHaveBeenLastCalledWith({});
    await source.read("c2");
    expect(native.collection).toHaveBeenLastCalledWith({ cursor: "c2" });
  });
  it("maps signed-out, a malformed page and a thrown call", async () => {
    expect(
      await nativeCollectionSource(
        plugin({ collection: async () => ({ kind: "signed-out" as const }) })
      ).read()
    ).toEqual({ kind: "signed-out" });
    expect(
      await nativeCollectionSource(
        plugin({
          collection: async () => ({ kind: "page", page: {} }) as never,
        })
      ).read()
    ).toEqual({ kind: "unavailable" });
    expect(
      await nativeCollectionSource(
        plugin({ collection: () => Promise.reject(new Error("x")) })
      ).read()
    ).toEqual({ kind: "unavailable" });
  });
});
