import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import {
  collectionFixtureWriter,
  collectionFixtureStore,
  resetCollectionFixtures,
} from "./local/collectionFixtures";
import type { CollectionScenario } from "./local/collectionFixtures";
import { cleanLocationName } from "./local/locationCommands";
import { casefold } from "./local/locationNames";
let sequence = 0;
const options = (idempotencyKey = `location-${++sequence}`) => ({
  signal: new AbortController().signal,
  idempotencyKey,
});
async function settle<T>(p: Promise<T>): Promise<T> {
  const outcome = p.then(
    (value) => ({ value }),
    (error) => ({ error })
  );
  await vi.runAllTimersAsync();
  const result = await outcome;
  if ("error" in result) throw result.error;
  return result.value;
}
function fixture(
  scenario: CollectionScenario = "normal",
  owner: "a" | "b" = "a"
) {
  return {
    writer: collectionFixtureWriter(owner, scenario),
    store: collectionFixtureStore(owner, scenario),
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  resetCollectionFixtures();
});
afterEach(() => vi.useRealTimers());
describe("ordinary fixture Locations", () => {
  it("uses Python trim, codepoint length, control rules and Unicode casefold", () => {
    expect(cleanLocationName(" \u0085 Name \u001c")).toBe("Name");
    expect(cleanLocationName("😀".repeat(120))).toHaveLength(240);
    expect(() => cleanLocationName("😀".repeat(121))).toThrow(
      "INVALID_LOCATION_NAME"
    );
    for (const name of ["", "  ", "a\nb", "a\u0000b"])
      expect(() => cleanLocationName(name)).toThrow("INVALID_LOCATION_NAME");
    expect(casefold("Straße Σς")).toBe(casefold("STRASSE σσ"));
    expect(cleanLocationName("\u007f")).toBe("\u007f"); // Core checks ord < 32, not every Unicode control.
  });
  it("creates trimmed roots, replays exactly once, rejects key reuse and isolates owners with colliding ids", async () => {
    const { writer, store } = fixture();
    const b = fixture("normal", "b");
    const before = structuredClone(b.store);
    const input = { name: " Box ", parentId: null };
    const key = options();
    const [one, two] = await settle(
      Promise.all([
        writer.createLocation(input, key),
        writer.createLocation(input, key),
      ])
    );
    expect(one).toEqual(two);
    expect(one.location.name).toBe("Box");
    expect(one.location.depth).toBe(1);
    expect(store.revision).toBe(2);
    await expect(
      settle(writer.createLocation({ ...input, name: "Other" }, key))
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    expect(b.store).toEqual(before);
    await settle(
      b.writer.editLocation({ id: "5", name: "B only", version: 1 }, options())
    );
    expect(store.locations.find((n) => n.id === "5")?.name).toBe(
      "Empty binder"
    );
    expect(await settle(writer.undoList(options()))).toEqual([]);
  });
  it("checks sibling uniqueness across create, rename and move without partial mutations", async () => {
    const { writer, store } = fixture();
    await expect(
      settle(
        writer.createLocation({ name: "binders", parentId: null }, options())
      )
    ).rejects.toMatchObject({ code: "LOCATION_NAME_CONFLICT" });
    await expect(
      settle(
        writer.editLocation(
          { id: "4", name: "BLUE BINDER", version: 1 },
          options()
        )
      )
    ).rejects.toMatchObject({ code: "LOCATION_NAME_CONFLICT" });
    await settle(
      writer.createLocation(
        { name: "Empty binder", parentId: "2", parentVersion: 1 },
        options()
      )
    );
    const before = structuredClone(store);
    await expect(
      settle(
        writer.editLocation(
          { id: "5", parentId: "2", parentVersion: 2, version: 1 },
          options()
        )
      )
    ).rejects.toMatchObject({ code: "LOCATION_NAME_CONFLICT" });
    expect(store).toEqual(before);
  });
  it("requires conversion for stocked leaves and moves every Holding with revision versions into the new child", async () => {
    const { writer, store } = fixture();
    const rows = store.rows.filter((r) => r.locationId === "3");
    await expect(
      settle(
        writer.createLocation(
          { name: "Sleeves", parentId: "3", parentVersion: 1 },
          options()
        )
      )
    ).rejects.toMatchObject({ code: "STOCKED_LOCATION_REQUIRES_CONVERSION" });
    await expect(
      settle(
        writer.createLocation(
          {
            name: "Sleeves",
            parentId: "5",
            parentVersion: 1,
            conversion: "move_holdings_to_child",
          },
          options()
        )
      )
    ).rejects.toMatchObject({ code: "INVALID_LOCATION_CONVERSION" });
    const created = await settle(
      writer.createLocation(
        {
          name: "Sleeves",
          parentId: "3",
          parentVersion: 1,
          conversion: "move_holdings_to_child",
        },
        options()
      )
    );
    expect(
      rows.every((r) => r.locationId === created.location.id && r.version === 2)
    ).toBe(true);
    expect(store.locations.find((n) => n.id === "3")).toMatchObject({
      kind: "organization",
      version: 2,
    });
    expect(created.location.depth).toBe(3);
  });
  it("checks current and destination versions; root moves need no destination version; flips old and new parent kinds", async () => {
    const { writer, store } = fixture();
    for (const input of [
      { id: "5", parentId: "2", version: 1 },
      { id: "5", parentId: "2", parentVersion: 2, version: 1 },
      { id: "5", name: "New", version: 2 },
    ])
      await expect(
        settle(writer.editLocation(input, options()))
      ).rejects.toMatchObject({ code: "STALE_LOCATION" });
    await expect(
      settle(writer.createLocation({ name: "New", parentId: "2" }, options()))
    ).rejects.toMatchObject({ code: "STALE_LOCATION" });
    const child = await settle(
      writer.createLocation(
        { name: "Child", parentId: "5", parentVersion: 1 },
        options()
      )
    );
    await settle(
      writer.editLocation(
        { id: child.location.id, parentId: "2", parentVersion: 1, version: 1 },
        options()
      )
    );
    expect(store.locations.find((n) => n.id === "5")).toMatchObject({
      kind: "storage_leaf",
      version: 3,
    });
    expect(store.locations.find((n) => n.id === "2")).toMatchObject({
      kind: "organization",
      version: 2,
    });
    const moved = await settle(
      writer.editLocation(
        { id: child.location.id, parentId: null, version: 2 },
        options()
      )
    );
    expect(moved.location).toMatchObject({ depth: 1, version: 3 });
  });
  it("refuses cycles, stocked move targets, missing nodes, Decks and empty edits", async () => {
    const { writer, store } = fixture();
    for (const parentId of ["2", "3"])
      await expect(
        settle(
          writer.editLocation(
            { id: "2", parentId, parentVersion: 1, version: 1 },
            options()
          )
        )
      ).rejects.toMatchObject({ code: "LOCATION_CYCLE" });
    await expect(
      settle(
        writer.editLocation(
          { id: "5", parentId: "3", parentVersion: 1, version: 1 },
          options()
        )
      )
    ).rejects.toMatchObject({ code: "STOCKED_LOCATION_REQUIRES_CONVERSION" });
    await expect(
      settle(writer.editLocation({ id: "5", version: 1 }, options()))
    ).rejects.toMatchObject({ code: "EMPTY_LOCATION_EDIT" });
    await expect(
      settle(
        writer.deleteLocation(
          { id: "missing", confirmName: "Gone", version: 1 },
          options()
        )
      )
    ).rejects.toMatchObject({ code: "LOCATION_NOT_FOUND" });
    store.locations.find((n) => n.id === "5")!.kind = "deck";
    await expect(
      settle(
        writer.createLocation(
          { name: "Child", parentId: "5", parentVersion: 1 },
          options()
        )
      )
    ).rejects.toMatchObject({ code: "DECK_CANNOT_HAVE_CHILDREN" });
    await expect(
      settle(
        writer.editLocation({ id: "5", name: "Deck", version: 1 }, options())
      )
    ).rejects.toMatchObject({ code: "DECK_REQUIRES_DECK_COMMAND" });
    await expect(
      settle(
        writer.deleteLocation(
          { id: "5", confirmName: "Empty binder", version: 1 },
          options()
        )
      )
    ).rejects.toMatchObject({ code: "DECK_REQUIRES_DECK_COMMAND" });
  });
  it("enforces depth 12 on create and on an entire moved branch", async () => {
    const { writer, store } = fixture();
    let parentId: string | null = null;
    let parentVersion: number | undefined;
    for (let i = 1; i <= 12; i++) {
      const r: Awaited<ReturnType<typeof writer.createLocation>> = await settle(
        writer.createLocation(
          { name: `Level ${i}`, parentId, parentVersion },
          options()
        )
      );
      parentId = r.location.id;
      parentVersion = 1;
    }
    await expect(
      settle(
        writer.createLocation(
          { name: "Too deep", parentId, parentVersion },
          options()
        )
      )
    ).rejects.toMatchObject({ code: "LOCATION_DEPTH_LIMIT" });
    await expect(
      settle(
        writer.editLocation(
          { id: "2", parentId, parentVersion, version: 1 },
          options()
        )
      )
    ).rejects.toMatchObject({ code: "LOCATION_DEPTH_LIMIT" });
    expect(store.locations.find((n) => n.id === "2")?.parent_id).toBe(null);
  });
  it("orders delete stale, cleaned exact name, emptiness, and replays deleted results; last child restores its parent leaf", async () => {
    const { writer, store } = fixture();
    for (const [input, code] of [
      [{ id: "3", confirmName: "wrong", version: 2 }, "STALE_LOCATION"],
      [
        { id: "3", confirmName: "wrong", version: 1 },
        "LOCATION_NAME_CONFIRMATION_MISMATCH",
      ],
      [
        { id: "3", confirmName: "Blue binder", version: 1 },
        "LOCATION_NOT_EMPTY",
      ],
      [{ id: "2", confirmName: "Binders", version: 1 }, "LOCATION_NOT_EMPTY"],
    ] as const)
      await expect(
        settle(writer.deleteLocation(input, options()))
      ).rejects.toMatchObject({ code });
    const child = await settle(
      writer.createLocation(
        { name: "Child", parentId: "5", parentVersion: 1 },
        options()
      )
    );
    const input = { id: child.location.id, confirmName: " Child ", version: 1 };
    const key = options();
    const result = await settle(writer.deleteLocation(input, key));
    expect(await settle(writer.deleteLocation(input, key))).toEqual(result);
    expect(store.locations.find((n) => n.id === "5")).toMatchObject({
      kind: "storage_leaf",
      version: 3,
    });
    expect(store.revision).toBe(3);
    expect(await settle(writer.undoList(options()))).toEqual([]);
  });
  it.each(["location-failure", "location-stale"] as const)(
    "retries %s without multiple application",
    async (scenario) => {
      const { writer, store } = fixture(scenario);
      const key = options();
      const input = { id: "5", name: "Saved", version: 1 };
      await expect(settle(writer.editLocation(input, key))).rejects.toThrow();
      await settle(writer.editLocation(input, key));
      await settle(writer.editLocation(input, key));
      expect(store.revision).toBe(2);
    }
  );
  it("aborts a slow command before mutation", async () => {
    const { writer, store } = fixture("location-slow");
    const c = new AbortController();
    const p = writer.createLocation(
      { name: "Late", parentId: null },
      { signal: c.signal, idempotencyKey: "slow" }
    );
    const outcome = expect(p).rejects.toMatchObject({ name: "AbortError" });
    c.abort();
    await settle(outcome);
    expect(store.revision).toBe(1);
  });
});
it("does not mutate on invalid tree or nonempty Unsorted edits", async () => {
  const { writer, store } = fixture();
  await expect(
    settle(
      writer.editLocation({ id: "1", name: "Renamed", version: 1 }, options())
    )
  ).rejects.toMatchObject({ code: "LOCATION_NOT_EMPTY" });
  store.locations.find((n) => n.id === "5")!.parent_id = "missing";
  await expect(
    settle(
      writer.createLocation(
        { name: "Child", parentId: "5", parentVersion: 1 },
        options()
      )
    )
  ).rejects.toMatchObject({ code: "INVALID_LOCATION_TREE" });
  expect(store.revision).toBe(1);
});
it("validates names before replay and scopes successful edit replay to the entire payload", async () => {
  const { writer, store } = fixture();
  const input = { id: "5", name: "Saved", version: 1 };
  const key = options();
  const one = await settle(writer.editLocation(input, key));
  expect(await settle(writer.editLocation(input, key))).toEqual(one);
  await expect(
    settle(writer.editLocation({ ...input, name: "Other" }, key))
  ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  await expect(
    settle(writer.editLocation({ ...input, name: "" }, key))
  ).rejects.toMatchObject({ code: "INVALID_LOCATION_NAME" });
  expect(store.revision).toBe(2);
});
