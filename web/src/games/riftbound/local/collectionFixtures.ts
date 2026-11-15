import type { TreeNode } from "../../../location_generated";
import type { CollectionReader, HoldingRow } from "../collection";
import { expandCopies, pageHoldings } from "../collection";
import { editions } from "./fixtures";
export type CollectionScenario = "normal" | "empty" | "failure" | "slow";
export function collectionFixtureReader(
  owner: "a" | "b",
  scenario: CollectionScenario = "normal"
): CollectionReader {
  const node = (
    id: string,
    name: string,
    parent_id: string | null = null,
    kind = "storage_leaf"
  ) => ({
    id,
    name,
    parent_id,
    kind,
    version: 1,
    depth: parent_id ? 2 : 1,
    hidden: false,
    for_trade: false,
    lent_copies: "0",
    borrowed_copies: "0",
  });
  const locations: TreeNode[] = [
    node("1", "Unsorted"),
    ...(scenario === "empty"
      ? []
      : [
          node("2", "Binders", null, "organization"),
          node("3", "Blue binder", "2"),
          node("4", "Red binder", "2"),
          node("5", "Empty binder"),
        ]),
  ];
  const holding = (
    edition: HoldingRow["edition"],
    locationId: string,
    quantity: number
  ): HoldingRow => ({ edition, locationId, quantity, version: 1 });
  const rows =
    scenario === "empty"
      ? []
      : owner === "b"
        ? [holding({ ...editions[0], name: "Beacon Keeper" }, "1", 2)]
        : [
            holding(editions[0], "1", 3),
            holding(editions[0], "3", 2),
            holding(editions[1], "4", 2),
            holding(editions[3], "3", 1),
            holding(
              {
                ...editions[2],
                id: "retained",
                printingId: "retained-printing",
                name: "Forgotten Sentinel",
              },
              "4",
              1
            ),
            ...editions.slice(5).map((e) => holding(e, "3", 3)),
          ];
  const failed = new Set<string>();
  async function read<T>(
    value: T,
    signal: AbortSignal,
    operation: string
  ): Promise<T> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          signal.removeEventListener("abort", abort);
          resolve();
        },
        scenario === "slow" ? 900 : 120
      );
      function abort() {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      }
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
    if (
      scenario === "failure" &&
      !failed.has(operation) &&
      operation !== "holdings"
    ) {
      failed.add(operation);
      throw new Error("Synthetic failure");
    }
    return value;
  }
  return {
    scope: "riftbound",
    owner,
    locations: (signal) => read(locations, signal, "locations"),
    holdings: (id, signal) =>
      read(
        rows.filter((r) => r.edition.id === id),
        signal,
        "holdings"
      ),
    list: (q, signal) => {
      const search = q.search.trim().toLowerCase();
      const matches = rows
        .filter(
          (r) =>
            (q.location === "all" || q.location === r.locationId) &&
            (!search ||
              r.edition.name.toLowerCase().includes(search) ||
              r.edition.number.toLowerCase().includes(search))
        )
        .sort(
          (a, b) =>
            a.edition.name.localeCompare(b.edition.name) ||
            a.edition.set.code.localeCompare(b.edition.set.code) ||
            a.edition.number.localeCompare(b.edition.number) ||
            a.edition.id.localeCompare(b.edition.id)
        );
      const copies = expandCopies(matches);
      return read(
        {
          rows: pageHoldings(matches, q.page),
          totals: {
            copies: copies.length,
            editions: new Set(matches.map((r) => r.edition.id)).size,
          },
          pages: Math.max(1, Math.ceil(copies.length / 24)),
          collectionEmpty: rows.length === 0,
        },
        signal,
        "list"
      );
    },
  };
}
