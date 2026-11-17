import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  POKEMON_EXACT,
  POKEMON_TREES,
  pokemonUpstream,
  underPokemon,
} from "../src/pokemonRoutes";

// The /api/pokemon allowlist against the API contract (api/tests/api_contract/routes.json): exactly the intended 60
// routes move, and no shared route is reachable through it, whatever a path parameter is filled in with.
type Route = [string[], string, string];
const routes = (
  JSON.parse(
    readFileSync("api/tests/api_contract/routes.json", "utf8")
  ) as Route[]
).filter(([, path]) => path.startsWith("/api/"));

// The 60 routes that move, written out: derived once from routes.json and committed, so swapping one tree for another
// with the same route count fails here instead of passing against a list built from the allowlist itself.
const EXPECTED_MOVED = [
  "GET /api/admin/card-attributes/queue",
  "GET /api/admin/card-attributes/{printing_id}",
  "GET /api/admin/card-attributes/{printing_id}/history",
  "GET /api/admin/card-identities",
  "GET /api/admin/card-identities/likely-reprints",
  "GET /api/admin/card-identities/queue",
  "GET /api/admin/card-identities/{identity_id}",
  "GET /api/admin/card-identities/{identity_id}/history",
  "GET /api/admin/catalog-metadata/queue",
  "GET /api/admin/catalog-metadata/{kind}/{target_id}",
  "GET /api/admin/catalog-metadata/{kind}/{target_id}/history",
  "GET /api/admin/catalog-reviews",
  "GET /api/admin/catalog-reviews/{review_id}/editions",
  "GET /api/admin/catalog-rules",
  "GET /api/admin/catalog-runs",
  "GET /api/admin/missing-card-reports",
  "GET /api/catalog/attribute-reports",
  "GET /api/catalog/attribute-reports/{report_id}",
  "GET /api/catalog/edition-replacements",
  "GET /api/catalog/editions",
  "GET /api/catalog/metadata-reports",
  "GET /api/catalog/metadata-reports/{report_id}",
  "GET /api/catalog/printings/{printing_id}",
  "GET /api/catalog/search",
  "GET /api/catalog/sets",
  "GET /api/catalog/status",
  "GET /api/collection-imports/current",
  "GET /api/collection-imports/{import_id}/left-out.csv",
  "GET /api/collection-imports/{import_id}/rows",
  "GET /api/collection-imports/{import_id}/skipped.csv",
  "GET /api/missing-card-reports",
  "GET /api/missing-card-reports/{report_id}",
  "GET /api/want-list",
  "GET /api/want-list/cost",
  "GET /api/want-list/exports/tcgplayer",
  "GET /api/want-list/exports/tcgplayer.txt",
  "PATCH /api/catalog/attribute-reports/{report_id}",
  "PATCH /api/catalog/metadata-reports/{report_id}",
  "PATCH /api/missing-card-reports/{report_id}",
  "POST /api/admin/card-attributes/decisions",
  "POST /api/admin/card-attributes/reports/{report_id}/decision",
  "POST /api/admin/card-identities/decisions",
  "POST /api/admin/card-identities/likely-reprints/dismiss",
  "POST /api/admin/card-identities/likely-reprints/{decision_id}/undo",
  "POST /api/admin/catalog-metadata/decisions",
  "POST /api/admin/catalog-metadata/reports/{report_id}/decision",
  "POST /api/admin/catalog-reviews/{review_id}/decision",
  "POST /api/admin/catalog-runs",
  "POST /api/admin/missing-card-reports",
  "POST /api/admin/missing-card-reports/{report_id}/decision",
  "POST /api/admin/reprint-groups/decisions",
  "POST /api/catalog/attribute-reports",
  "POST /api/catalog/metadata-reports",
  "POST /api/collection-imports",
  "POST /api/collection-imports/{import_id}/changes",
  "POST /api/collection-imports/{import_id}/save",
  "POST /api/holdings/reassign",
  "POST /api/missing-card-reports",
  "POST /api/prices/editions",
  "POST /api/trades/value",
];

const intended = (methods: string[], path: string) => {
  const route = path.slice("/api/".length);
  const tree = POKEMON_TREES.some(
    (name) => route === name || route.startsWith(`${name}/`)
  );
  const exact = POKEMON_EXACT[route];
  return {
    tree,
    exactMethods: exact ? methods.filter((m) => exact.includes(m)) : [],
  };
};

// Every literal segment the allowlist names, plus a neutral one: each is tried in place of every path parameter, so a
// shared pattern such as /api/trades/{trade_id}/accept is probed with trade_id = "value".
const fillers = [
  "x",
  ...new Set(
    [...POKEMON_TREES, ...Object.keys(POKEMON_EXACT)].flatMap((route) =>
      route.split("/")
    )
  ),
];
const concrete = (path: string) =>
  fillers.map((filler) => path.replace(/\{[^}]+\}/g, filler));

describe("what /api/pokemon can reach, walked over the contract", () => {
  it("moves exactly the intended 60 routes", () => {
    const moved: string[] = [];
    for (const [methods, path] of routes) {
      for (const method of methods) {
        const hits = concrete(path).map((candidate) =>
          pokemonUpstream(`/api/pokemon/${candidate.slice(5)}`, method)
        );
        const { tree, exactMethods } = intended(methods, path);
        const shouldMove = EXPECTED_MOVED.includes(`${method} ${path}`);
        // The allowlist agrees with the literal list in both directions.
        expect(tree || exactMethods.includes(method), `${method} ${path}`).toBe(
          shouldMove
        );
        for (const [index, hit] of hits.entries()) {
          if (shouldMove)
            expect(hit, `${method} ${path}`).toBe(concrete(path)[index]);
          else
            expect(
              hit,
              `${method} ${path} as ${concrete(path)[index]}`
            ).toBeNull();
        }
        if (shouldMove) moved.push(`${method} ${path}`);
      }
    }
    expect(moved).toHaveLength(60);
    expect([...moved].sort()).toEqual(EXPECTED_MOVED);
  });

  it("answers null for a single route with another method or a longer path", () => {
    for (const [route, methods] of Object.entries(POKEMON_EXACT)) {
      for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
        if (!methods.includes(method))
          expect(pokemonUpstream(`/api/pokemon/${route}`, method)).toBeNull();
      }
      for (const longer of [`${route}/x`, `${route}/accept`, `${route}/`])
        expect(
          pokemonUpstream(`/api/pokemon/${longer}`, methods[0])
        ).toBeNull();
    }
    expect(
      pokemonUpstream("/api/pokemon/trades/value/accept", "POST")
    ).toBeNull();
    expect(pokemonUpstream("/api/pokemon/holdings/reassign", "GET")).toBeNull();
  });

  it("keeps the query string, and leaves other paths alone", () => {
    expect(
      pokemonUpstream("/api/pokemon/catalog/editions?q=a%20b&q=c", "GET")
    ).toBe("/api/catalog/editions?q=a%20b&q=c");
    expect(pokemonUpstream("/api/catalog/editions", "GET")).toBeUndefined();
    expect(pokemonUpstream("/api/pokemonx/catalog", "GET")).toBeUndefined();
    expect(underPokemon("/api/pokemon")).toBe(true);
    expect(underPokemon("/api/pokemonx")).toBe(false);
  });

  it("answers 404, never an exception, for names an object would inherit", () => {
    for (const name of [
      "toString",
      "constructor",
      "__proto__",
      "hasOwnProperty",
      "valueOf",
      "isPrototypeOf",
    ])
      for (const method of ["GET", "POST", "PUT", "DELETE", undefined])
        for (const path of [
          `/api/pokemon/${name}`,
          `/api/pokemon/${name}/x`,
          `/api/pokemon/admin/${name}`,
        ])
          expect(pokemonUpstream(path, method), `${method} ${path}`).toBeNull();
  });

  it("refuses dot segments, encoded slashes and backslashes in the raw target, whatever else the path is", () => {
    for (const hostile of [
      "/api/pokemon/%2e%2e/loans",
      "/api/pokemon/%2E%2E/loans",
      "/api/pokemon/%2e./loans",
      "/api/pokemon/.%2E/loans",
      "/api/pokemon/./catalog/sets",
      "/api/pokemon/%2e/catalog/sets",
      "/api/pokemon/../loans",
      "/api/pokemon/catalog/%2e%2e/%2e%2e/loans",
      "/api/pokemon/catalog/../../loans",
      "/api/pokemon/catalog/sets/..",
      "/api/pokemon\\catalog\\sets",
      "/api/pokemon/catalog\\..\\loans",
      "/api/pokemon/catalog%2fsets",
      "/api/pokemon/catalog%2Fsets",
      "/api/pokemon/catalog%5csets",
      "/api/pokemon/catalog%5Csets",
      "/api/pokemon%2fcatalog/sets",
      "/api/pokemon%5ccatalog/sets",
      "http://gateway.test/api/pokemon/%2e%2e/loans",
      "http://h\\api/pokemon/%2e%2e/loans",
      "http://h\\api\\pokemon\\catalog",
      "/api\\pokemon/%2e%2e/loans",
      "/api\\pokemon/../loans",
      "/api\\pokemon/catalog/sets",
    ])
      expect(pokemonUpstream(hostile, "GET"), hostile).toBeNull();
  });
});
