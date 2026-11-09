# Riftbound catalog milestone: scope and source facts

Status: draft for Ryan. Refs #534. Riftbound-specific work lives on `integration/riftbound-backend`, not `dev`.

## Decided on 2026-11-08: the Riftbound branch

Ryan's words, as said:

> "yes lets just make sure all work goes on a new riftbound branch that we will keep until we are ready to deploy riftbound on dev"

## Decided (2026-11-09)

Ryan's words, as said. Asked whether the retained Riftbound branch should hold only Riftbound-specific work or the shared core modularization work too, he said:

> "only riftbound specific"

and:

> "core modularization can go to dev"

On the first milestone's scope he said:

> "yes i agree with this scope however we should work with the idea that we can ingest real riftbound data because we will not be awaiting data rights we are just going to work with what is given on tcgcsv"

The scope he agreed to: start with the catalog; leave owner-specific routes and moving user identity out of Pokémon's database for later. "Owner routes" here means administrative routes such as catalog-import review, not ordinary collection features. The frontend separation work would block only client-facing work.

What follows:

- The first milestone is catalog-first.
- Administrative owner routes (for example catalog-import review) are deferred, and so is moving user identity out of Pokémon's database.
- Frontend separation (#532) blocks only client-facing work.
- Real Riftbound data will be ingested from what TCGCSV provides, without waiting for separate rights clearance.
- This supersedes the "synthetic only until a data gate passes" framing: #563 D3, #575 H10 and Q-G1, and #563 R13, the "data gate" prerequisite. #563, #564 and #575 are open pull requests into `dev`; they are not edited here.
- Riftbound-specific work stays on `integration/riftbound-backend`, and core modularization can go to `dev` (the 2026-11-09 clarification of the 2026-11-08 branch decision).
- #563 D4, catalog shape: Riftbound's own database reuses the shared catalog table structure and relationships, with Riftbound-specific write constraints. This is not a separate schema or translation layer. Ryan's words, answering the question of whether to reuse the structure with game-specific constraints:

  > "what does this entail exactly"

  After the assistant's explanation, which Ryan accepted, that Riftbound would use the same kinds of catalog tables and relationships as Pokémon, in its own database, with adjusted write rules, and that no Pokémon data is copied (it "doesn't mean copying Pokémon cards into Riftbound's database") and the choice does not decide how alternate-art cards are grouped:

  > "yes that sounds good it will lower the amount of new work that needs to be done and make maintenance easier is that not why we split the core from the game specific?"

- D4 does not decide how the per-game write constraints get installed; that is IM-11.
- Card Identity grouping. The question put to Ryan was whether one Card Identity should cover the same underlying card, with each artwork or promo kept as a separate printing, for example Ahri, Alluring's regular and alternate-art versions grouped while Ahri, Inquisitive stays a different card, with uncertain matches flagged for review and TCGCSV's pair of Kai'Sa versions with conflicting text given as a case. His answer was:

  > "yes"

  What that settles:
  - One Card Identity per underlying card.
  - Each artwork or promo version stays a separate Card Printing.
  - Product and finish distinctions (Card Editions), prices and physical copies stay separate.
  - A different card with a similar name (Ahri, Inquisitive versus Ahri, Alluring) stays a separate Card Identity.
  - Uncertain or conflicting matches go to review, never a blind name-only merge.
  - The Kai'Sa pair with conflicting text stays a review case and is not silently reconciled.
  - Note on terms: `CONTEXT.md` defines Card Identity by English card name, and treats differing text within a name as a Reprint Group question. Riftbound's approved grouping instead sends same-name pairs with conflicting text, such as Kai'Sa, to review rather than merging them automatically. Whether `CONTEXT.md` gains a Riftbound entry is not decided (see below).
- Catalog writer approach. The question put to Ryan was whether to build a small Riftbound-specific writer first, using the shared catalog structure, rather than refactoring Pokémon's existing importer into shared code before we know what both games need, extracting the genuinely common parts once there are two working examples. His answer was:

  > "yes"

  What that settles, and nothing more (where the writer lives and how it is approached):
  - Riftbound gets a small writer of its own that uses the shared catalog structure.
  - Pokémon's importer is not refactored into shared code first.
  - Genuinely common parts are extracted later, once there are two working examples.
- App composition (#575 Q-D1). The question put to Ryan was whether to use a shared core app builder with a separate entry point for each game, rather than one entry point that switches behavior on a game setting. He asked whether "separate entry" meant URLs such as /api/pokemon and /api/riftbound, and was told it meant separate application entry points in the code, with public URL prefixes a separate routing choice. His answers were:

  > "yes separate entry meaning like /api/pokemon vs /api/riftbound correct?"

  > "ok yes to the separate entry approach, it doesnt need to be that exact setup but something like that in the case that we want to expand to even more games in the future"

  What that settles:
  - A shared core app builder holds the common setup.
  - Each game has its own application entry point in code, with that game's routes and configuration listed explicitly.
  - The shape allows more games to be added later.
  - No runtime game setting or registry, per ADR 0023. The ADR 0023 wording change is being drafted as a `dev` docs PR.
- Migration tracks (#564 IM-11, the principle of option B). The question put to Ryan was whether to keep Pokémon's existing migration history intact and add separate core and game-specific tracks for new databases, rather than running every game's migrations everywhere or moving old files and rewriting existing migration records. His answer was:

  > "yes i agree"

  What that settles:
  - Pokémon's existing migration files and history stay as they are and are not rewritten.
  - New databases get separate core and game-specific tracks.
  - No database runs every game's migrations.
  - Tooling and tests must prove each resulting schema.
- Track selection (#564 IM-12). The question put to Ryan was whether to give each database an explicit migration command over a shared runner, rather than a single command that picks a game from a runtime setting. His answer was:

  > "yes"

  What that settles:
  - Each database gets an explicit migration command over a shared runner.
  - No single command picks a game from a runtime setting.
- Core baseline (#564 IM-13, option A, cut now). The question put to Ryan was whether to create a clean core baseline now from the existing schema, with automated checks that it matches the intended shared schema and seed data, so that Riftbound has a starting point without replaying Pokémon-specific history. His answer was:

  > "yes"

  What that settles:
  - A clean core baseline is built now from the existing schema.
  - Automated checks show it matches the intended shared schema and seed data.
  - New game databases do not replay Pokémon-specific history.
  - Applying it to any live database is not approved.
- Hosting design (#564 IM-14). The question put to Ryan was whether Riftbound should live in its own database with its own database role, on the same PostgreSQL server as Pokémon, keeping data and permissions separate without running another server, though one server outage would affect both, with the separation tested explicitly. His answer was:

  > "yes"

  What that settles:
  - Riftbound gets its own database and its own database role, on the same PostgreSQL server as Pokémon.
  - Separation of data and permissions must be tested explicitly.
  - The risk that one server outage takes down both games is accepted.
- Future requirement for IM-14. Ryan added:

  > "in the future we may want to separate them so keep note"

  That is the whole decision: keep a practical path to separate servers later. Separate hosting is not being built now.

  What keeping that path open implies (coordinator's note, not a separate decision):
  - No cross-database queries, foreign keys or `dblink`/FDW between the game databases.
  - Each backend reaches its database only through its own connection setting.
  - Nothing assumes both databases share one server.
- Request-signing keys (#564 IM-6), design only. After the explanation that the same key also signs pagination cursors, that the gateway uses it to sign the user identity and request details sent to the backend, that it is separate from the login-session secret, that keeping Pokémon's key avoids invalidating its existing cursors, and that giving Riftbound its own key would limit cross-game impact if a backend key were compromised, the question put to Ryan was whether the team should use separate keys in the design. His answer was:

  > "yes"

  What that settles:
  - Pokémon keeps its current gateway-to-backend key, so existing Pokémon pagination cursors stay valid.
  - Each game backend gets its own separate gateway-to-game key, Riftbound included.
  - The design has to account for the key's existing uses, which are request signing, cursors and tokens (#564 IM-6).
  - This key is distinct from the login-session secret, and the two must not be conflated.
  - No key is created, generated, transmitted, configured or rotated, and no live security or access setting changes. Each of those needs Ryan's separate approval.
- IM-14 (hosting) and IM-6 (keys) are design choices only. Creating a live database or role, generating or configuring credentials, deploying, and changing live access settings each need Ryan's separate approval.
- Nothing from these decisions is applied to a live database.

## Not decided

Nothing below is settled. No recommendation is implied.

- Generation promotion: how the Riftbound writer promotes generations, tombstones and refuses bulk drops.
- #564 IM-16: what a backend must prove to change shared identity, and how auth gets the stored value.
- Deploy topology: gateway routing, on/off switch, compose service, backups (not yet tracked in #575).
- Public URL prefixes (related to #575 H8 / Q-D1), for example whether paths look like /api/pokemon and /api/riftbound. Ryan said "it doesnt need to be that exact setup but something like that", so the approach is open and no exact scheme is chosen.
- #564 IM-14 test topology: co-located test harness by default, or split.
- Whether `CONTEXT.md` gains a Riftbound entry for how Card Identity and Reprint Group map to Riftbound's grouping.
- How the review queue is surfaced.
- Image display.

## Source facts

From the researcher report of 2026-11-09 (research notes kept outside the repo). Labels: VERIFIED was seen directly; INFERRED is a deduction; UNKNOWN was not found. Most quotes came through summarizing fetch tools and are not byte-exact, so re-check any quote before formal use.

### Endpoints and cadence (VERIFIED, https://tcgcsv.com/docs)

- `/tcgplayer/categories`
- `/tcgplayer/{cat}/groups`
- `/tcgplayer/{cat}/{group}/products` (`getExtendedFields=true`)
- `/tcgplayer/{cat}/{group}/prices`
- Daily archives at `/archive/tcgplayer/prices-YYYY-MM-DD.ppmd.7z`, about 1 GB each, immutable, from 2024-02-08.
- JSON shape `{success, errors, results, totalItems}`; prices in USD; CSV is also offered.
- `robots.txt` is `User-agent: *` / `Allow: /`.
- Updated once a day, around 20:00 UTC. The freshness marker is `/last-updated.txt` (read 2026-11-08T20:05:45+0000).

### Request etiquette (VERIFIED, https://tcgcsv.com/docs)

- Send a `YourApplication/X.Y.Z` User-Agent; generic or missing ones may be blocked.
- Sleep 100 ms between requests. Abusive rates get the IP throttled for 10 minutes.
- A full sync is about 10,000 requests at most. More than 10,000 a day, or repeated archive downloads, may get you banned.
- Not for browsers (CORS); ingest server-side only.

### Riftbound coverage (VERIFIED)

Category 89, "Riftbound League of Legends Trading Card Game", has 14 groups:

- 24832 Legacy LGC
- 24901 Gift of the Rift Bundle GRFT
- 24819 Radiance RAD
- 24861 T1 2025 Worlds Champion Bundles
- 24698 Vendetta VEN
- 24560 Unleashed UNL
- 24519 Spiritforged SFD
- 24552 Judge Promos JDG
- 24344 Origins OGN
- 24439 Origins: Proving Grounds OGS
- 24528 Organized Play Promos OPP
- 24343 Promos PR
- 24502 Worlds Bundle 2025 RWB
- 24797 Secret Garden SGN

`publishedOn` is not a reliable release date. Bundle groups suggest sealed products are mixed in (INFERRED).

### Fields seen (VERIFIED, sampled from group 24552, 4 products)

- Product: productId, name, cleanName, imageUrl, categoryId, groupId, url, modifiedOn, imageCount, presaleInfo, and extendedData[name, displayName, value].
- Extended fields: Rarity, Number ("111/298"), Description, Energy Cost, Power Cost (sometimes absent), Might, Card Type, Tag, Domain, Flavor Text (contains HTML).
- Price: productId, low, mid, high, market, directLow, subTypeName. Only "Foil" was seen.

### Gaps

- No separate set code or collector-number field. No language field, no alt-art or overnumbered flag.
- Products carry no finish; finish appears only in the price subtype.
- Whether Normal price rows exist is UNKNOWN.
- Main-set rarities, sealed, token and alt-art handling are unsampled. Sample one larger group to check.

### Terms and attribution

- TCGCSV publishes no terms of use, license or commercial-use clause on `/`, `/docs` or `/faq` (VERIFIED absence).
- Its FAQ, asked whether permission is needed, says "You don't. Permission is implicit." On attribution it says "Nope. A link thanking TCGCSV is always appreciated." (VERIFIED, https://tcgcsv.com/faq). This is a statement in an FAQ, not a license grant, and this document does not read it as one.
- The repository github.com/CptSpaceToaster/tcgcsv shows no license (UNKNOWN).
- Inferred: consumers are bound only by the FAQ and usage notes, which grant no license.
- It is run as "a hobby and a one-man show", with no SLA, versioning or change-notice promise. Contact is a Discord; GitHub issues are open.

### Upstream: TCGplayer

- TCGCSV says: "The bulk of the information offered here from TCGplayer is a direct export from their API endpoints." (VERIFIED, https://tcgcsv.com/docs)
- TCGplayer's API is closed to new applicants: "We are no longer granting new API access at this time." (VERIFIED, https://docs.tcgplayer.com/docs/getting-started.md)
- The TCGplayer API terms and ToS returned HTTP 403 to fetch. The points below come from search snippets only and are unverified:
  - API access is at TCGplayer's "sole discretion", and keys "can't be shared with third parties".
  - The ToS says "You agree not to crawl, scrape or spider any of our websites without express permission from us."
- No published terms were found for caching or redistributing TCGplayer product or price data.

### Images

- `imageUrl` points at the TCGplayer CDN: `https://tcgplayer-cdn.tcgplayer.com/product/{productId}_200w.jpg`. The art is presumably the publisher's (INFERRED).
- TCGCSV's FAQ (https://tcgcsv.com/faq) says that for the most part you can't use card images, adding that marketplaces generally seem to be allowed to use them for display and identification, and not to make games or gameplay experiences with someone else's card images online (VERIFIED).
- Nothing found licenses displaying them. Project policy keeps card art out of git.

## Ingestion constraints any design must respect

- Server-side only, stored in our own database.
- Send a PrizeCheck/X.Y.Z User-Agent, sleep at least 100 ms between requests, and stay far under 10,000 requests a day.
- Check `last-updated.txt` first and sync at most once a day, after about 20:00 UTC.
- Never re-download archives.
- Don't scrape tcgplayer.com or use TCGplayer API keys.
- No images in git, and display rights are unresolved.
- Treat "permission is implicit" as not a license.

## Open uncertainties

- Commercial use of the data and prices.
- Image display.
- TCGplayer ToS text, beyond search snippets.
- Whether the TCGCSV repository has a LICENSE file.
- Normal-finish rows, main-set rarities, and sealed and token coverage.
- How long the operator's upstream access will last.
