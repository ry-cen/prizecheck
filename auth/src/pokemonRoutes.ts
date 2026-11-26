// Pokémon-only routes are also served under /api/pokemon/ (the per-game prefix). This is a transitional, additive
// rewrite: the gateway maps /api/pokemon/<rest> to the upstream's existing /api/<rest> before anything else looks at the
// path (public, budget, import-limit and art checks, and the identity and budget signatures), so the API keeps receiving,
// and signing over, exactly the paths it has today. The old /api/<rest> paths are retained unchanged while open tabs,
// caches and native clients still use them; removing them needs a later, explicit rollout decision
// (docs/planning/pokemon-api-prefix.md).
//
// Only the routes below move. Every other /api/pokemon... is a 404 that reaches no session lookup, limiter or upstream.
// A route that is one route in the API contract is matched exactly (and by method), so a longer path can never fall
// into a shared route's pattern (/api/trades/value/accept must not become /api/trades/{id}/accept).

export const POKEMON_PREFIX = "/api/pokemon";

/** Prefixes whose whole subtree is Pokémon-only: `<route>` and `<route>/...`, any method. */
export const POKEMON_TREES = [
  "catalog",
  "collection-imports",
  "want-list",
  "missing-card-reports",
  "admin/missing-card-reports",
  "admin/catalog-reviews",
  "admin/catalog-metadata",
  "admin/card-attributes",
  "admin/card-identities",
];

/** Single routes, matched exactly and only for the methods the API contract has for them. */
export const POKEMON_EXACT: Record<string, string[]> = {
  "prices/editions": ["POST"],
  "trades/value": ["POST"],
  "holdings/reassign": ["POST"],
  "admin/catalog-runs": ["GET", "POST"],
  "admin/catalog-rules": ["GET"],
  "admin/reprint-groups/decisions": ["POST"],
};

// Own entries only: `POKEMON_EXACT["toString"]` or `["__proto__"]` would read an inherited property.
const EXACT = new Map(Object.entries(POKEMON_EXACT));

/**
 * The namespace is decided on the raw request target, before any URL normalisation: `/api/pokemon/%2e%2e/loans` is
 * normalised to `/api/loans`, so deciding afterwards would let it out of the namespace. The authority of an absolute-form
 * target ends at `/`, `\`, `?` or `#`, as WHATWG URL parsing ends it.
 */
export function rawPathOf(target: string): string {
  const absolute = /^[a-z][a-z0-9+.-]*:\/\/[^/\\?#]*/i.exec(target);
  const path = absolute ? target.slice(absolute[0].length) : target;
  return path.split(/[?#]/, 1)[0];
}

/**
 * True when `/api/pokemon` is followed by the end of the path or by a separator, raw or percent-encoded. A backslash
 * counts as the slash it is parsed as (`/api\pokemon/..` is `/api/pokemon/..`).
 */
export function underPokemon(target: string): boolean {
  const path = rawPathOf(target).replace(/\\/g, "/");
  if (!path.startsWith(POKEMON_PREFIX)) return false;
  const next = path.charAt(POKEMON_PREFIX.length);
  return next === "" || next === "/" || next === "%";
}

// A dot segment (raw or percent-encoded, any case), a backslash, or an encoded slash or backslash: none of these may
// appear in a /api/pokemon path, whatever follows.
function hostile(path: string): boolean {
  if (path.includes("\\") || /%(?:2f|5c)/i.test(path)) return true;
  return path
    .replace(/%2e/gi, ".")
    .split("/")
    .some((segment) => segment === "." || segment === "..");
}

function resolve(target: string, method: string | undefined) {
  if (!underPokemon(target)) return undefined;
  const raw = rawPathOf(target);
  if (hostile(raw)) return null;
  const url = new URL(target, "http://gateway.invalid");
  if (!url.pathname.startsWith(`${POKEMON_PREFIX}/`)) return null;
  const rest = url.pathname.slice(POKEMON_PREFIX.length + 1);
  const methods = EXACT.get(rest);
  const moved =
    (methods !== undefined &&
      method !== undefined &&
      methods.includes(method)) ||
    POKEMON_TREES.some((tree) => rest === tree || rest.startsWith(`${tree}/`));
  return moved ? `/api/${rest}${url.search}` : null;
}

/**
 * For a request target under /api/pokemon: the upstream path and query (`/api/<rest>?...`) when it is a moved route, or
 * null when it is not (the caller answers 404). `undefined` means the target is not under /api/pokemon at all. Total:
 * the gateway calls it before any try block, so anything unexpected inside is a 404, never an exception.
 */
export function pokemonUpstream(
  target: string,
  method: string | undefined
): string | null | undefined {
  try {
    return resolve(target, method);
  } catch {
    return underPokemon(target) ? null : undefined;
  }
}
