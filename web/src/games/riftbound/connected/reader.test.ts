import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { CatalogReadError, emptyQuery, failureKind } from "../catalog";
import { supportedView } from "../navigation";
import { parseView } from "../navigation";
import { connectedReader, finishLabel, toEdition } from "./reader";

const signal = () => new AbortController().signal;
const edition = (over = {}) => ({
  id: "e1",
  printing_id: "p1",
  name: "Card",
  set: { id: "s1", name: "Set", code: "" },
  number: "001/100",
  finish: "normal",
  art: null,
  ...over,
});
const body = (over = {}) => ({
  editions: [edition()],
  total: 1,
  pages: 1,
  catalog_empty: false,
  ...over,
});
const reply = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status });
const stub = (...responses: Array<Response | Error>) => {
  const fn = vi.fn(async () => {
    const next = responses.shift()!;
    if (next instanceof Error) throw next;
    return next;
  });
  vi.stubGlobal("fetch", fn);
  return fn;
};
const urls = (fn: ReturnType<typeof stub>) =>
  fn.mock.calls.map((c) => (c as unknown as [string])[0]);
const kind = async (run: () => Promise<unknown>) =>
  run().then(
    () => "resolved",
    (e) => (e instanceof CatalogReadError ? e.kind : "other:" + e)
  );

afterEach(() => vi.unstubAllGlobals());

describe("connected reader", () => {
  it("maps an API page to the UI shape", async () => {
    stub(
      reply(
        body({
          editions: [
            edition({ finish: "unspecified" }),
            edition({ id: "e2", finish: "holo_alt" }),
            edition({ id: "e3", finish: "foil" }),
          ],
          total: 3,
        })
      )
    );
    const page = await connectedReader().list(emptyQuery, signal());
    expect(page.editions.map((e) => e.finish)).toEqual([
      "Unspecified Variant",
      "Holo Alt",
      "Foil",
    ]);
    const first = page.editions[0];
    expect(first.art).toBeNull();
    expect(first.set.code).toBe("");
    expect([first.domain, first.type, first.orientation]).toEqual([
      null,
      null,
      null,
    ]);
    expect(first.printingId).toBe("p1");
    expect(page).toMatchObject({ catalogEmpty: false, page: 1, total: 3 });
    expect(finishLabel("")).toBe("Unspecified Variant");
    expect(toEdition(edition()).finish).toBe("Normal");
  });

  it("requests only the Riftbound prefix and the served filters", async () => {
    const wide = () => reply(body({ total: 99, pages: 9 }));
    const fn = stub(wide(), wide(), wide(), wide());
    const reader = connectedReader();
    await reader.list(
      {
        search: "  knight\u0000 ",
        set: "syn01",
        domain: "Fury",
        type: "Unit",
        page: 2,
      },
      signal()
    );
    await reader.list({ ...emptyQuery, set: "" }, signal());
    await reader.list({ ...emptyQuery, set: "x".repeat(81) }, signal());
    await reader.list({ ...emptyQuery, set: "a\u0000b" }, signal());
    const [a, b, c, d] = urls(fn);
    expect(a).toBe("/api/riftbound/catalog/editions?q=knight&set=syn01&page=2");
    expect(b).toBe("/api/riftbound/catalog/editions?page=1");
    expect(c).toBe("/api/riftbound/catalog/editions?page=1");
    expect(d).toBe("/api/riftbound/catalog/editions?page=1");
  });

  it("clamps a stale page against a positive total", async () => {
    const fn = stub(
      reply(body({ editions: [], total: 30, pages: 2 })),
      reply(body({ total: 30, pages: 2 }))
    );
    const page = await connectedReader().list(
      { ...emptyQuery, page: 9 },
      signal()
    );
    expect(urls(fn)[1]).toContain("page=2");
    expect(page.page).toBe(2);
    const empty = stub(
      reply(body({ editions: [], total: 0, pages: 0, catalog_empty: true }))
    );
    const result = await connectedReader().list(
      { ...emptyQuery, page: 9 },
      signal()
    );
    expect(empty).toHaveBeenCalledTimes(1);
    expect(result.catalogEmpty).toBe(true);
  });

  it("caps the page at 100000", async () => {
    const fn = stub(reply(body({ total: 9, pages: 200000 })));
    await connectedReader().list({ ...emptyQuery, page: 10_000_000 }, signal());
    expect(urls(fn)[0]).toContain("page=100000");
  });

  it("refuses an over-long search without a request", async () => {
    const fn = stub();
    const run = () =>
      connectedReader().list(
        { ...emptyQuery, search: "x".repeat(121) },
        signal()
      );
    expect(await kind(run)).toBe("invalid");
    expect(fn).not.toHaveBeenCalled();
  });

  it("maps statuses", async () => {
    const reader = connectedReader();
    const calls: Record<string, () => Promise<unknown>> = {
      list: () => reader.list(emptyQuery, signal()),
      sets: () => reader.sets(signal()),
      detail: () => reader.detail("e1", signal()),
    };
    const expected: Array<[number, string]> = [
      [401, "denied"],
      [403, "denied"],
      [422, "invalid"],
      [500, "unavailable"],
      [502, "unavailable"],
      [503, "unavailable"],
    ];
    for (const [name, run] of Object.entries(calls))
      for (const [status, want] of expected) {
        stub(reply({}, status));
        expect(await kind(run), `${name} ${status}`).toBe(want);
      }
    stub(reply({}, 404));
    expect(await kind(calls.list)).toBe("unavailable");
    stub(reply({ detail: "Edition not found" }, 404));
    expect(await reader.detail("e1", signal())).toBeNull();
    expect(await reader.detail("", signal())).toBeNull();
    for (const run of Object.values(calls)) {
      stub(new TypeError("Failed to fetch"));
      expect(await kind(run)).toBe("unavailable");
    }
  });

  it("propagates abort", async () => {
    const controller = new AbortController();
    controller.abort();
    stub(new DOMException("aborted", "AbortError"));
    const error = await connectedReader()
      .list(emptyQuery, controller.signal)
      .catch((e) => e);
    expect(error.name).toBe("AbortError");
    expect(error).not.toBeInstanceOf(CatalogReadError);
  });

  it("failureKind treats unknown errors as unavailable", () => {
    expect(failureKind(new Error("x"))).toBe("unavailable");
    expect(failureKind(undefined)).toBe("unavailable");
    expect(failureKind(new CatalogReadError("denied"))).toBe("denied");
  });

  it("the connected entry never imports fixtures", () => {
    for (const file of ["main.tsx", "reader.ts"]) {
      const text = readFileSync(
        `web/src/games/riftbound/connected/${file}`,
        "utf8"
      );
      expect(text).not.toContain("local/");
      expect(text).not.toContain("fixtures");
    }
  });

  it("supportedView strips facets only for a facet-less reader", () => {
    const view = parseView("#riftbound:domain=Fury&type=Unit&search=a");
    expect(supportedView(view, { facets: false }).query).toMatchObject({
      domain: "",
      type: "",
      search: "a",
    });
    expect(supportedView(view, {})).toBe(view);
    expect(supportedView(view, { facets: true })).toBe(view);
  });
});
