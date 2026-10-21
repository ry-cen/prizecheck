# Card image sources for a self-hosted catalog

Checked: 2026-10-21. Sources: each provider's own pages and terms, linked below. A researcher compared the sources; the primary session measured the sample images (pixel sizes with `sips`, bytes with `curl`) and TCGdex's energy coverage. No application behavior changed.

## Question

TCGdex has no artwork for many basic energy printings, so collectors see a placeholder for cards they may own in limited quantities. The owner asked whether PrizeCheck should store its own copy of the whole catalog's artwork, from a source with higher quality images than TCGdex (TCGplayer and Limitless TCG were suggested), and what that would cost to host.

## Finding

No source is both clearly licensed for re-hosting and better than TCGdex across the catalog.

- Limitless fills TCGdex's energy gaps but is not a quality upgrade: its large images are 460×640, smaller than TCGdex's 600×825.
- pokemontcg.io is the only clean render source at higher resolution (733×1024), and its API is closing.
- TCGplayer's large images are photographs of physical cards, not clean renders, and its API is closed to new developers.

## TCGdex gaps

TCGdex lists 336 basic energy cards (`/v2/en/cards?category=Energy&energyType=Normal`), and 161 of them have no image. They include every card in `sve` (Scarlet & Violet basic energy, 24 cards) and `mee` (Mega Evolution basic energy, 8 cards), plus many `tk-*` trainer-kit energies. TCGdex tracks missing images in an open task that asks contributors to upload them through its Ingest tool. [tcgdex/cards-database#2341](https://github.com/tcgdex/cards-database/issues/2341)

## Sources compared

Each sample is the first card of a Scarlet & Violet set (SV base set or SVE #1).

| Source | Measured sample | SV and ME basic energy | Access | Terms on images |
| --- | --- | --- | --- | --- |
| TCGdex (current) | `high.webp` 600×825, 75 KB; `low.webp` about 245×342, 8–22 KB | none for `sve` or `mee` ([sve](https://api.tcgdex.net/v2/en/sets/sve), [mee](https://api.tcgdex.net/v2/en/sets/mee)) | already used; asset sizes per [tcgdex.dev/assets](https://tcgdex.dev/assets) | The data repository is MIT licensed; nothing states that the licence covers images. [repo](https://github.com/tcgdex/cards-database) |
| Limitless TCG | `_LG.png` 460×640, 85–150 KB; `_XL` returns 403 | SVE 24 cards ([page](https://limitlesstcg.com/cards/SVE)), MEE 16 ([page](https://limitlesstcg.com/cards/MEE)) | predictable CDN path `…/tpci/{SET}/{SET}_{NNN}_R_EN_{SM\|LG}.png`, found by scraping set pages | No terms page; credits the images to The Pokémon Company. [legal](https://limitlesstcg.com/legal) |
| pokemontcg.io | `_hires.png` 733×1024, 250–900 KB | `sve` #1–16 only ([API](https://api.pokemontcg.io/v2/cards?q=set.id:sve)); `mee` unverified (API errors) | static CDN `images.pokemontcg.io/{set}/{n}_hires.png` | No image terms. New API sign-ups are closed and keys work until 2027-03-01 ([docs](https://docs.pokemontcg.io/)); its successor Scrydex forbids redistributing or mirroring ([terms](https://scrydex.com/terms)). |
| TCGplayer | `{productId}_in_1000x1000.jpg` 713×1000, 98 KB; a photo of a physical card | one image per product listing | CDN path keyed by the TCGplayer product ID PrizeCheck already stores | API closed to new developers ([docs](https://docs.tcgplayer.com/docs/getting-started)); terms page returned 403; a no-scraping clause is reported only secondhand; `robots.txt` sets Crawl-Delay 10 |
| pokemon.com card database | about 245×342, 81 KB | has SVE ([page](https://www.pokemon.com/us/pokemon-tcg/pokemon-cards/series/sve/1/)) | `assets.pokemon.com/…/cards/web/{SET}/{SET}_EN_{n}.png` | Terms forbid downloading "quantities of content to a database for any reason" and commercial use (§5). [Terms of use](https://www.pokemon.com/us/terms-of-use) |
| PkmnCards | not measured | has SVE | scraping a WordPress site | credits The Pokémon Company; its own terms not read |

## Matching images to Card Editions

Joining sources on set code and collector number is unsafe for energies:

- Card counts differ between sources. SVE has 24 cards in TCGdex and Limitless but 16 in pokemontcg.io. MEE has 8 in TCGdex but 16 in Limitless.
- Limitless links reprinted energies to one shared TCGplayer product. SVE #1 links to an sv01 product, and MEE #9 to a "30th Celebration" product, 713248 ([MEE/9](https://limitlesstcg.com/cards/MEE/9)).

That conflicts with the physical-Edition identity in [ADR 0007](../../../../adr/0007-edition-marketplace-metadata-boundary.md). A product ID or set number can only suggest a match, which an owner confirms.

## Hosting cost

Prices read 2026-10-21, US East.

- **Storage.** At about 734×1024 the whole catalog is about 2.4 GB: about 20,000 printings, each with a WebP large image (about 100 KB) and thumbnail (about 20 KB). The missing energies alone are about 15 MB.
- **Bandwidth.** The gallery loads only thumbnails, and large images load when a card is opened. One visitor scrolling the whole catalog loads about 0.4 GB.

| Scenario | S3 direct | S3 + CloudFront | Cloudflare R2 |
| --- | --- | --- | --- |
| Storage, per month | about $0.06 | about $0.06 | $0 (under the 10 GB free tier) |
| Small user base (about 0.75 GB, 30k requests) | about $0.01 | $0 | $0 |
| One visitor loads every thumbnail (0.4 GB, 20k requests) | about $0.01 | $0 | $0 |
| A script downloads everything 1,000 times a month (2.4 TB, 40M requests) | about $223 | about $147 | about $11 (read requests only) |

Pricing sources:

- [R2 pricing](https://developers.cloudflare.com/r2/pricing/) (updated 2026-10-01): storage $0.015/GB-month; egress free; free tier 10 GB, 1M writes and 10M reads a month.
- [CloudFront pay-as-you-go](https://aws.amazon.com/cloudfront/pricing/pay-as-you-go/): 1 TB and 10M requests free a month, then $0.085/GB.
- [S3 pricing](https://aws.amazon.com/s3/pricing/): GET $0.0004 per 1,000; first 100 GB out free. The $0.09/GB egress and $0.023/GB-month storage figures come from secondary sources.

Mitigations on any host:

- Use content-hashed keys with `Cache-Control: public, max-age=31536000, immutable`.
- Always serve through a CDN, never straight from the bucket.
- Rate-limit per visitor, and set a billing alarm.

## Legal question

Not legal advice. Card art is The Pokémon Company's copyright. Every community source disclaims affiliation, and none grants a licence to re-host the art. The Pokémon Company's own terms forbid bulk downloading into a database. So whether a small fan app may re-host the catalog rests on The Pokémon Company tolerating it. Hot-linking, as PrizeCheck does today, raises the same copyright question.

## Recommendation

1. Keep TCGdex as the base and fill only its gaps. Copy the missing energy and trainer-kit images (from Limitless, for example), have the owner confirm each match on an owner review screen, and offer them back to TCGdex's missing-images task.
2. Host anything PrizeCheck stores on Cloudflare R2 behind Cloudflare's cache. It is effectively free at this size, and scraping can't run up bandwidth charges.
3. Defer a full-catalog quality upgrade. pokemontcg.io is the only clean higher-resolution source, and its API closes on 2027-03-01. TCGplayer offers photographs under terms that could not be read.

## Not verified

- Trainer-kit (`tk-*`) energy coverage on any source.
- Whether pokemontcg.io has `mee` or the Scarlet & Violet trainer kits (its API returned 500 and 502).
- TCGplayer's own terms, and its coverage of MEE and trainer-kit energies.
- Limitless coverage of trainer kits.
- Pokémon TCG Live assets and Bulbapedia Archives (not researched).
- S3 storage and egress rates on AWS's own page.
- What CloudFront's flat-rate plans do at their limits.
- Whether R2 reads served from Cloudflare's cache are billed.
