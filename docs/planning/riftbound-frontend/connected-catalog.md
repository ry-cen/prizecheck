# Connected Riftbound Catalog: local proof (#661)

A local proof, not production identity (#531) and not a launch. It builds on `dev`: the #677 refresh landed through #682, and the per-game runtime seam (#685) and P-STATE (#684) are on `dev` too.

**Chain.** Catalog page → generated client (`web/src/games/riftbound/catalog_generated.ts`, from the Riftbound OpenAPI by `scripts/generate_riftbound_catalog_client.py`) → `/api/riftbound/catalog/...` → the gateway (session required, path rewritten to `/api/...`) → `app.riftbound_main` → the Riftbound database. `npm run check:client` fails when the generated file is stale.

**Adapter** (`connected/reader.ts`, the dev-only entry `connected/index.html`; absent from the production build).

| API | Page |
| --- | --- |
| `finish` `normal`, `foil`, `unspecified` | Normal, Foil, Unspecified Variant; any other key is title-cased |
| `art: null`, `set.code: ""` | no art ("Artwork unavailable"); tile label drops the empty code |
| no domain, type or orientation | none invented; the chips and facts line are hidden (`facets: false`), and a facet in the address is ignored |
| `page` past `pages` | one more read of the last page; the view shows the page returned |
| search over 120 characters | refused before any request |
| 401, 403 / 422 / 404 on detail / anything else, incl. network | denied / invalid / "not available" / unavailable |

**Copy.** Empty: "No cards in this catalog yet." Denied: "Sign in to see the Catalog." Unavailable: "Cards couldn't be loaded." with Retry. Invalid: "That search is too long. Try a shorter one." with Clear search. No source, status code or service is named.

**Fixtures** stay in `local/` and run only from `npm run dev:riftbound`. The connected entry never imports them and never falls back to them.

**Identity.** The gateway forwards no `x-internal-*` header, so every real Catalog read is a 401 today. The spec (`web/tests/riftbound-connected.spec.ts`, helper `web/tests/support/riftbound-stack.ts`) runs a test-only relay on loopback between the gateway and the backend. It signs one synthetic principal with a secret made per run and fails any request that already carries identity. That proves Catalog reads for one principal; identity propagation and per-user authorization remain open under #531. One test pins today's behaviour: a signed-in collector with no forwarded identity is denied by the backend. The seed writes the accepted generation directly, so it proves reading an accepted snapshot, not ingestion acceptance.

**Run.** `TMPDIR=/tmp npm run verify:local -- --suite browser --shard 1/1 --browser-workers 1 -- web/tests/riftbound-connected.spec.ts`. It needs a database role that can create databases; it creates and drops one `tcg_rb_*` database per run.

**Recommendation for #531 (not implemented).** The gateway signs Riftbound requests with the same HMAC transport and a Riftbound-only key, over the rewritten path, method, body hash, the core account id and time, forwards no budget headers, and keeps dropping client `x-internal-*` headers. The backend accepts a current and a previous key during rotation. Provisioning the key needs the owner's approval.
