# Frontend composition: a narrow follow-on to ADR 0023

**Status:** authorized by the owner on 2026-10-30, after the core/game assessments of `dev` at `ce9e3e1`. Base: [ADR 0023](../../adr/0023-split-core-and-games-by-composition.md), which split the backend and left the web app unsplit.

This is a narrow follow-on, not a rewrite of the web app's architecture. It applies ADR 0023's rule to `web/src` for two bounded pieces of Pokémon vocabulary and adds a check that keeps the rule from slipping back. Everything else in `web/src` stays where it is.

## The rule

- **Shared code is a library.** A file outside `web/src/games/<game>/` is shared. It imports no game and names no game's values in the pieces moved so far.
- **The game composes.** `web/src/games/pokemon/` owns the Pokémon values it holds. Shared code that needs one takes it as a required argument with no default, so a missed call site fails to typecheck.
- **Composition points are listed.** A shared module that passes a game's values into shared code (a page, or a text module that keeps an old export in place) is a mixed composition point. It is named in `scripts/web_boundary_allowlist.txt`, and `scripts/check_web_boundaries.py` fails on any other shared-to-game import and on any game-to-game import. See [verification](../../agents/verification.md#web-boundaries).
- **No registry, no `GAME` flag, no inheritance and no second-game framework.** A new piece moves only code that exists today.
- **Nothing a collector sees changes**: words, order, tones, headings, labels, accessible names and routes stay the same, and so do the API and its OpenAPI document.

## What moved

1. **Formats and legality words**: `web/src/games/pokemon/formats.ts`. The Formats in their order, each with a short name (`GLC`, for chips, pills and deck cards) and a long name (`Gym Leader Challenge`, for pickers and sentences), the standing words, and the standing tones the Catalog and deck builder card popups share. The five lists that repeated them now derive from it. Their old exports stay in place, so callers keep their import lines:
   - `catalog/catalogText.ts`: `FORMATS` (short), `FORMAT_NAMES` (long), and the `STANDING_WORDS` and `STANDING_TONES` re-exports;
   - `decks/targetFormat.ts`: `TargetFormat`, `TARGET_FORMATS` (long), `formatLabel`, and `statusOf`'s words and tones;
   - `discover/discoverText.ts`: `FORMAT_CHIPS`, `FORMAT_LABELS` (short);
   - `owner/reprintValues.ts`: `legalityText` (short names, standing words).
2. **Deck List grouping**: `web/src/games/pokemon/deckGroups.ts`. `POKEMON_DECK_GROUPING` holds the group order, headings and the group a line belongs to, and `kindText` holds a line's card-type words. `decks/deckListModel.ts` stays shared: `groupLines(lines, grouping)` and `deckListModel(detail, grouping)` take a `DeckGrouping` as a required parameter and keep copies, places, loans and prices. The deck builder (`DeckBuilderPage.tsx`) and the Published Deck (`publishedDeckModel.ts`) pass Pokémon's grouping in, and the copy sheet (`CopySheet.tsx`) reads `kindText` from the game. The three Tool words stay distinct: the group heading `Tools`, the line's `Trainer · Tool`, and Catalog's `Tool` chip.

Characterization tests (`web/src/catalog/formatVocabulary.test.ts`, `web/src/decks/deckGrouping.test.ts`) were written against the code before the move and still pass unchanged after it. They live in folders that `vitest.config.ts` already includes.

## Deferred

These need their own authorization. Some overlap open work:

- Collection and Workspace facets, `galleryPrefs` and `queryToParams` (overlap PR #447);
- identity-line and Variant consolidation;
- export and scanner moves, client base paths;
- shell, routing, lazy pages and preloading (overlap PR #447);
- Catalog's type chips (`KINDS`) and the Workspace's `Pokémon Tool` facet words.
