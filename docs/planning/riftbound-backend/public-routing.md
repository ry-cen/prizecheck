# Riftbound public routing through the gateway

Issue [#534](https://github.com/ry-cen/prizecheck/issues/534). Owner decision, 2026-11-16: Riftbound gets its own `/api/riftbound` prefix through the existing gateway, and Pokémon's URLs stay unchanged. Recorded in the 2026-11-16 amendment to [ADR 0023](../../adr/0023-split-core-and-games-by-composition.md). Identity and key setup are separate decisions and are not started here.

## Mapping

The gateway (`auth/src/server.ts`) answers `/api/riftbound/<rest>` and forwards it to the Riftbound backend as `/api/<rest>`, query string kept. The internal routes come from the local Riftbound Catalog read API (draft PR #677, `docs/planning/riftbound-backend/catalog-read-api.md` there).

| Public path (browser to gateway) | Riftbound backend path |
| --- | --- |
| `GET /api/riftbound/catalog/sets` | `GET /api/catalog/sets` |
| `GET /api/riftbound/catalog/editions?q=&set=&page=` | `GET /api/catalog/editions?q=&set=&page=` |
| `GET /api/riftbound/catalog/editions/{id}` | `GET /api/catalog/editions/{id}` |
| `/api/riftbound` and `/api/riftbound/` (bare, with or without the trailing slash) | 404, no upstream call |

The branch runs before the generic `/api/` branch, so a `/api/riftbound` path never reaches the Pokémon upstream.

**One namespace, read twice.** The URL parser resolves dot segments and reads a backslash as a slash, so the gateway decides whether a request is in the `/api/riftbound` namespace on the raw request target and again on the normalised path. If the two disagree, or the raw target is in the namespace and carries a dot segment (`.` or `..`, raw or percent-encoded in any case), an encoded slash (`%2f`) or backslash (`%5c`, or a literal `\`), the answer is 404 before any same-origin check, session lookup, body read or upstream call. So `/api/riftbound/%2e%2e/loans` and `/api/riftbound\..\loans` never reach the Pokémon upstream, and `/api/catalog/%2e%2e/riftbound/x` never reaches Riftbound. Other targets are handled as before; `/api//riftbound/x` is a Pokémon path, and `/api/riftbound//x` is forwarded as `/api//x`. Paths that only contain the word deeper in, such as `/api/catalog/search?q=riftbound`, or that merely begin with it, such as `/api/riftboundx/…`, are Pokémon paths and behave as before. The nginx location `^/(api|auth)/` already sends the prefix to the gateway, so no proxy change is needed.

When on, the gateway applies the checks the generic `/api/` branch applies to a non-public path: a non-GET/HEAD request must be same-origin (403 otherwise), and a session is required (401 otherwise). There are no Riftbound public routes. The response is relayed as the generic text path does it: status, content type and body text, `cache-control: no-store`. Request bodies are limited to 16,384 bytes (counted in bytes, not characters) and refused with 413 beyond that, before the upstream is contacted.

## Off by default

`RIFTBOUND_API_ORIGIN` names the Riftbound backend's origin. The gateway keeps only the origin of the value (`new URL(value).origin`, http or https), so a trailing slash or a path in the setting cannot change the upstream path. Unset, empty or unparsable (the default is unset), every `/api/riftbound` path answers 404 `{ "error": "Not found" }`, the gateway contacts no upstream and makes no session lookup. The setting appears in no compose, systemd, Docker, nginx, env-example, GitHub workflow or other deploy file, nor in `scripts/release_runtime.py` (`tests/tooling/test_proxy_config.py` checks `deploy/`, `.github/workflows/`, that script, the compose files and `.env*`); only tests set it, with a synthetic origin.

The setting name, the 404 body (the gateway's existing not-found shape) and requiring a session are reversible choices made in this slice, not owner decisions.

## No identity is forwarded yet

The gateway sends the Riftbound backend no `x-internal-user`, `x-internal-time`, `x-internal-signature` or budget header, drops any such header the client sends, and never signs with `INTERNAL_AUTH_SECRET` (Pokémon's key). It reads or creates no Riftbound key. The backend checks a signed user on every Catalog route, so it answers 401 and the gateway relays that. The route is therefore not usable until identity propagation is decided. The gateway still requires a session first, so an anonymous caller is refused before the backend is contacted.

## Next decisions (not started)

1. Identity propagation (#531, IM-16): how the signed user reaches the Riftbound backend, and what the gateway then signs.
2. Key provisioning: creating, storing and rotating `RIFTBOUND_INTERNAL_AUTH_SECRET`, with the owner's approval.
3. A generated web client for the Riftbound OpenAPI and a thin frontend adapter (below).
4. D4 facets: domain, type and orientation are not served.
5. Deployment: setting `RIFTBOUND_API_ORIGIN` on a real host, and running the Riftbound entry there.

## Future web adapter must handle

The adapter turns the real API into the `CatalogReader` shape in `web/src/games/riftbound/catalog.ts` (the #660 frontend branch).

- **Unsupported filter hash fields.** The fixture's `domain` and `type` filters are not served by the real API, which takes only `q`, `set` and `page`. Ignore or drop them rather than send a filter the backend does not apply, which would mislead the collector.
- **Missing metadata.** `art` is always null, a set `code` can be an empty string, and an Edition has no domain or type. The adapter and screens must render without them.
- **A stale page position with a positive total.** A page past the end returns no Editions with the real `total`. When `total > 0` and `page > pages`, clamp to the last page, as the fixture view does, and read that page.
- **Finish key labelling.** `finish` is a raw key (`normal`, `foil`, or `unspecified`). The adapter maps it to a display label; two finishes of one Printing are two Editions with the same `printing_id`.
