import { expect, it, vi } from "vitest";
import type { CollectionPage } from "../../collection_generated";
import { HoldingError } from "../../holdings_generated";
import { collectionFixturePages } from "./collectionFixture";
import { fixtureCollectionSource } from "./collectionSource";
import { FixtureSession, RETURN_URL } from "./fixtureSession";
import { gatewayCollectionSource } from "./gatewayCollection";

function memory() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
}
function signedIn() {
  const session = new FixtureSession(memory());
  const state = new URL(session.begin()).searchParams.get("state");
  session.returnFromBrowser(`${RETURN_URL}?state=${state}&result=success`);
  return session;
}

it("fixture source resolves later, never synchronously", async () => {
  const source = fixtureCollectionSource(signedIn());
  let settled = false;
  const pending = source.read().then((result) => {
    settled = true;
    return result;
  });
  expect(settled).toBe(false);
  expect((await pending).kind).toBe("page");
  expect(source.sample).toBe(true);
});
it("fixture source pages through the cursor and ends with null", async () => {
  const source = fixtureCollectionSource(signedIn());
  const first = await source.read();
  if (first.kind !== "page") throw new Error("expected a page");
  expect(first.page.entries.length).toBeGreaterThan(1);
  expect(first.page.next_cursor).toBeTruthy();
  const second = await source.read(first.page.next_cursor!);
  if (second.kind !== "page") throw new Error("expected a page");
  expect(second.page).toBe(collectionFixturePages[1]);
  expect(second.page.next_cursor).toBeNull();
});
it("fixture source is signed-out without a session and unavailable for an unknown cursor", async () => {
  expect(
    await fixtureCollectionSource(new FixtureSession(memory())).read()
  ).toEqual({ kind: "signed-out" });
  expect(await fixtureCollectionSource(signedIn()).read("nope")).toEqual({
    kind: "unavailable",
  });
});

const page: CollectionPage = {
  entries: [],
  owner_revision: 1,
  catalog_revision: 1,
  next_cursor: null,
};
it("gateway source passes the cursor to the generated client", async () => {
  const getCollection = vi.fn(async () => page);
  const source = gatewayCollectionSource({ getCollection });
  expect(source.sample).toBe(false);
  expect(await source.read("abc")).toEqual({ kind: "page", page });
  expect(getCollection).toHaveBeenCalledWith({}, "abc");
});
it("gateway source maps 401 to signed-out and other failures to unavailable", async () => {
  const read = (failure: () => Promise<CollectionPage>) =>
    gatewayCollectionSource({ getCollection: failure }).read();
  expect(
    await read(async () => {
      throw new HoldingError(401, "COLLECTION_UNAVAILABLE");
    })
  ).toEqual({ kind: "signed-out" });
  expect(
    await read(async () => {
      throw new HoldingError(500, "COLLECTION_UNAVAILABLE");
    })
  ).toEqual({ kind: "unavailable" });
  expect(await read(() => Promise.reject(new Error("offline")))).toEqual({
    kind: "unavailable",
  });
  expect(
    await read(async () => ({ nope: true }) as unknown as CollectionPage)
  ).toEqual({ kind: "unavailable" });
});
it("gateway readSession maps the session body", async () => {
  const session = (body: unknown, ok = true) => {
    const fetch = vi.fn(
      async () => ({ ok, json: async () => body }) as Response
    );
    return {
      fetch,
      read: () =>
        gatewayCollectionSource({
          fetch: fetch as typeof globalThis.fetch,
        }).readSession(),
    };
  };
  const yes = session({ signedIn: true, userId: "u" });
  expect(await yes.read()).toBe("signed-in");
  expect(yes.fetch).toHaveBeenCalledWith("/auth/session", {
    credentials: "same-origin",
  });
  expect(await session({ signedIn: false, userId: null }).read()).toBe(
    "signed-out"
  );
  expect(await session({ signedIn: "yes" }).read()).toBe("unavailable");
  expect(await session(null).read()).toBe("unavailable");
  expect(await session({ signedIn: true }, false).read()).toBe("unavailable");
  const rejecting = gatewayCollectionSource({
    fetch: (() => Promise.reject(new Error("offline"))) as typeof fetch,
  });
  expect(await rejecting.readSession()).toBe("unavailable");
});
