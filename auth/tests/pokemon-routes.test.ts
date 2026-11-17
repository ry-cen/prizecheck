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
        const shouldMove = tree || exactMethods.includes(method);
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
    ])
      expect(pokemonUpstream(hostile, "GET"), hostile).toBeNull();
  });
});
