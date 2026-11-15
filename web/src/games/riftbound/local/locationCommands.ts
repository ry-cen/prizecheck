import type { TreeNode } from "../../../location_generated";
import {
  CollectionError,
  type CollectionErrorCode,
  type CollectionWriter,
  type WriteOptions,
} from "../collection";
import type { FixtureStore } from "./collectionFixtures";
import { casefold } from "./locationNames";

export function cleanLocationName(raw: string): string {
  // Python str.strip includes U+001C–001F and U+0085, and excludes U+FEFF.
  const value = raw.replace(
    /^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/gu,
    ""
  );
  if (
    !value ||
    [...value].length > 120 ||
    [...value].some((c) => c.codePointAt(0)! < 32)
  )
    fail("INVALID_LOCATION_NAME");
  return value;
}
function fail(code: CollectionErrorCode): never {
  throw new CollectionError(code);
}
type Command = <T>(
  action: string,
  input: unknown,
  options: WriteOptions,
  apply: () => T
) => Promise<T>;
/** Ordinary Location commands only. No nested-Unsorted conversion, social commands or Undo. */
export function locationCommands(
  store: FixtureStore,
  command: Command
): Pick<
  CollectionWriter,
  "createLocation" | "editLocation" | "deleteLocation"
> {
  function get(id: string) {
    return (
      store.locations.find((n) => n.id === id) ?? fail("LOCATION_NOT_FOUND")
    );
  }
  function depth(id: string | null): number {
    const seen = new Set<string>();
    while (id !== null) {
      if (seen.has(id)) fail("INVALID_LOCATION_TREE");
      seen.add(id);
      const node = store.locations.find((n) => n.id === id);
      if (!node) fail("INVALID_LOCATION_TREE");
      id = node.parent_id;
    }
    return seen.size;
  }
  function parent(id: string | null, version?: number) {
    if (id === null) return undefined;
    const node = get(id);
    if (node.kind === "deck") fail("DECK_CANNOT_HAVE_CHILDREN");
    if (version === undefined || node.version !== version)
      fail("STALE_LOCATION");
    return node;
  }
  function unique(name: string, parentId: string | null, except?: string) {
    if (
      store.locations.some(
        (n) =>
          n.id !== except &&
          n.parent_id === parentId &&
          casefold(n.name) === casefold(name)
      )
    )
      fail("LOCATION_NAME_CONFLICT");
  }
  const stocked = (node: TreeNode) =>
    node.kind === "storage_leaf" &&
    store.rows.some((r) => r.locationId === node.id);
  function ordinary(id: string, version: number) {
    const node = get(id);
    if (node.kind === "deck") fail("DECK_REQUIRES_DECK_COMMAND");
    if (node.version !== version) fail("STALE_LOCATION");
    return node;
  }
  function updateParent(id: string | null) {
    if (id === null) return;
    const node = get(id);
    node.kind = store.locations.some((n) => n.parent_id === id)
      ? "organization"
      : "storage_leaf";
    node.version++;
  }
  function result(node: TreeNode) {
    store.revision++;
    for (const n of store.locations) n.depth = depth(n.id);
    return { location: structuredClone(node), ownerRevision: store.revision };
  }
  return {
    createLocation: async (input, options) => {
      const name = cleanLocationName(input.name); // Core validates before replay, with the raw payload as digest.
      return command("createLocation", input, options, () => {
        const p = parent(input.parentId, input.parentVersion);
        if (p && depth(p.id) >= 12) fail("LOCATION_DEPTH_LIMIT");
        unique(name, input.parentId);
        const convert = p && stocked(p);
        if (convert && input.conversion !== "move_holdings_to_child")
          fail("STOCKED_LOCATION_REQUIRES_CONVERSION");
        if (input.conversion && !convert) fail("INVALID_LOCATION_CONVERSION");
        const node: TreeNode = {
          id: crypto.randomUUID(),
          name,
          parent_id: input.parentId,
          kind: "storage_leaf",
          version: 1,
          depth: 1,
        };
        if (p) {
          p.kind = "organization";
          p.version++;
        }
        store.locations.push(node);
        if (convert)
          for (const r of store.rows)
            if (r.locationId === p.id) {
              r.locationId = node.id;
              r.version = store.revision + 1;
            }
        return result(node);
      });
    },
    editLocation: async (input, options) => {
      const name =
        input.name === undefined ? undefined : cleanLocationName(input.name);
      return command("editLocation", input, options, () => {
        const current = ordinary(input.id, input.version);
        if (name === undefined && !("parentId" in input))
          fail("EMPTY_LOCATION_EDIT");
        const destination =
          "parentId" in input ? input.parentId! : current.parent_id;
        const moving = destination !== current.parent_id;
        // UI gates Unsorted; retain the core's nonempty restriction for direct fixture commands.
        if (
          current.name === "Unsorted" &&
          current.parent_id === null &&
          (moving || (name !== undefined && name !== current.name)) &&
          (stocked(current) ||
            store.locations.some((n) => n.parent_id === current.id))
        )
          fail("LOCATION_NOT_EMPTY");
        let p: TreeNode | undefined;
        if (moving) {
          p = parent(destination, input.parentVersion);
          const branch = new Set([current.id]);
          let size = 0;
          while (size !== branch.size) {
            size = branch.size;
            for (const n of store.locations)
              if (n.parent_id && branch.has(n.parent_id)) branch.add(n.id);
          }
          if (destination && branch.has(destination)) fail("LOCATION_CYCLE");
          const relative = Math.max(
            ...[...branch].map((id) => depth(id) - depth(current.id))
          );
          if (depth(destination) + 1 + relative > 12)
            fail("LOCATION_DEPTH_LIMIT");
          if (p && stocked(p)) fail("STOCKED_LOCATION_REQUIRES_CONVERSION");
        }
        unique(name ?? current.name, destination, current.id);
        const previous = current.parent_id;
        current.name = name ?? current.name;
        current.parent_id = destination;
        current.version++;
        if (moving) {
          if (p) {
            p.kind = "organization";
            p.version++;
          }
          updateParent(previous);
        }
        return result(current);
      });
    },
    deleteLocation: async (input, options) => {
      const name = cleanLocationName(input.confirmName);
      return command("deleteLocation", input, options, () => {
        const current = ordinary(input.id, input.version);
        if (current.name !== name) fail("LOCATION_NAME_CONFIRMATION_MISMATCH");
        if (
          store.rows.some((r) => r.locationId === current.id) ||
          store.locations.some((n) => n.parent_id === current.id)
        )
          fail("LOCATION_NOT_EMPTY");
        store.locations = store.locations.filter((n) => n.id !== current.id);
        updateParent(current.parent_id);
        store.revision++;
        return { deletedId: current.id, ownerRevision: store.revision };
      });
    },
  };
}
