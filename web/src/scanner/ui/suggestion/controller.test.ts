import { describe, expect, it, vi } from "vitest";
import type { ScannerPrinting } from "../../../scanner_generated";
import type { LockResult } from "../../tray/store";
import {
  candidatesFrom,
  createSuggestions,
  type SuggestionHost,
} from "./controller";

const printing = (id: string, edition: string | null = "e-" + id) =>
  ({
    id,
    name: `Card ${id}`,
    set_name: "Set",
    collector_number: id.toUpperCase(),
    low_image_url: `https://img/${id}.png`,
    default_edition_id: edition,
    editions: [],
  }) as unknown as ScannerPrinting;

function setup(found: ScannerPrinting[] | null, pickResult?: LockResult) {
  const calls: string[] = [];
  const host: SuggestionHost = {
    answer: vi.fn((id, added, reason) =>
      calls.push(`answer ${id} ${added} ${reason ?? ""}`.trim())
    ),
    pick: vi.fn(async () => pickResult ?? { added: true }),
    settle: vi.fn((id, r) =>
      calls.push(`settle ${id} ${r.added} ${r.reason ?? ""}`.trim())
    ),
    openSearch: vi.fn(() => calls.push("search")),
  };
  const s = createSuggestions(async () => found);
  return { s, host, calls };
}
const lock = { lockId: 7, printingIds: ["a", "b", "c"] };

describe("candidatesFrom", () => {
  it("keeps the worker's order and drops printings with no active Edition", () => {
    const out = candidatesFrom(
      ["a", "b", "c"],
      [printing("c"), printing("a"), printing("b", null)]
    );
    expect(out.map((c) => c.printingId)).toEqual(["a", "c"]);
    expect(out[0]).toEqual({
      printingId: "a",
      name: "Card a",
      setLine: "Set A",
      image: "https://img/a.png",
    });
  });
});

describe("the Scan Suggestion", () => {
  it("shows the candidates that resolve and answers nothing yet", async () => {
    const { s, host, calls } = setup([
      printing("a"),
      printing("b", null),
      printing("c"),
    ]);
    await s.onSuggest(lock, host);
    expect(s.getView()?.candidates.map((c) => c.printingId)).toEqual([
      "a",
      "c",
    ]);
    expect(calls).toEqual([]);
  });

  it("settles as an unresolved lock when none resolves", async () => {
    const { s, host, calls } = setup([printing("a", null)]);
    await s.onSuggest(lock, host);
    expect(s.getView()).toBeNull();
    expect(calls).toEqual(["settle 7 false unresolved"]);
  });

  it("settles offline when the route fails", async () => {
    const { s, host, calls } = setup(null);
    await s.onSuggest(lock, host);
    expect(s.getView()).toBeNull();
    expect(calls).toEqual(["settle 7 false offline"]);
  });

  it("a pick applies that Printing first with the others after, then settles once", async () => {
    const { s, host, calls } = setup([
      printing("a"),
      printing("b"),
      printing("c"),
    ]);
    await s.onSuggest(lock, host);
    await s.pick("b");
    expect(host.pick).toHaveBeenCalledWith("b", ["a", "c"]);
    expect(calls).toEqual(["settle 7 true"]);
    expect(s.getView()).toBeNull();
    await s.pick("a");
    s.none();
    s.absent(7);
    expect(calls).toEqual(["settle 7 true"]);
  });

  it("settles a refused pick with its result", async () => {
    const { s, host, calls } = setup([printing("a")], {
      added: false,
      reason: "full",
      verdict: "full",
    });
    await s.onSuggest({ lockId: 7, printingIds: ["a"] }, host);
    await s.pick("a");
    expect(calls).toEqual(["settle 7 false full"]);
  });

  it("None of these sends dismissed and opens search, once", async () => {
    const { s, host, calls } = setup([printing("a")]);
    await s.onSuggest(lock, host);
    s.none();
    s.none();
    s.absent(7);
    expect(calls).toEqual(["answer 7 false dismissed", "search"]);
    expect(s.getView()).toBeNull();
  });

  it("absent closes the suggestion and sends dismissed, once", async () => {
    const { s, host, calls } = setup([printing("a")]);
    await s.onSuggest(lock, host);
    s.absent(8);
    expect(s.getView()).not.toBeNull();
    s.absent(7);
    s.absent(7);
    expect(calls).toEqual(["answer 7 false dismissed"]);
    expect(s.getView()).toBeNull();
  });

  it("an absence while the printings are loading is answered once and nothing shows", async () => {
    let release!: (p: ScannerPrinting[]) => void;
    const s = createSuggestions(() => new Promise((r) => (release = r)));
    const calls: string[] = [];
    const host = {
      answer: (id: number, _a: boolean, r?: string) =>
        calls.push(`answer ${id} ${r}`),
      settle: () => calls.push("settle"),
      pick: async () => ({ added: true }),
      openSearch: () => calls.push("search"),
    } as SuggestionHost;
    const done = s.onSuggest(lock, host);
    s.absent(7);
    release([printing("a")]);
    await done;
    expect(calls).toEqual(["answer 7 dismissed"]);
    expect(s.getView()).toBeNull();
  });
});
