# Game runtime: what one game's API supplies to the shared core

**Status:** implemented for #683 (WP-A), under [ADR 0023](../../adr/0023-split-core-and-games-by-composition.md). No Riftbound route changed.

## The seam

`app.core.game_runtime.GameRuntime` holds four things a game owns: `connect` (its database), `verify` (its gateway sign-in check), `cursor_secret` (its cursor key, read lazily) and `counter` (its own request counter). An entry passes one to `build_app(runtime=...)`; the builder stores it on `app.state.game_runtime`.

Core handlers take `user_id = Depends(verified_user)` and `game = Depends(game_runtime)` from `app.core.game_runtime` and open `game.connect()`. The wrapper keeps `app.identity.verified_user`'s three `Header` parameters, so the API contract is unchanged, and it awaits the runtime's verifier exactly once. An app with no runtime fails closed with a 500 before any database is opened.

## Rule

Core never imports `app.db` or `app.identity`, and never names `INTERNAL_AUTH_SECRET`. Shared reads and commands take `connect=` and `cursor_secret=` from the caller. A test pins this.

## Cursors

`encode_cursor`, `cursor_key`, `decode_cursor`, `deck_cursor_encode` and `deck_cursor_decode` require a keyword `secret`. Pokémon's is `INTERNAL_AUTH_SECRET`, so old cursors still decode. Riftbound's is HMAC-SHA256 of its own gateway key over a fixed label, so a cursor never crosses games even if both are configured with the same secret. A missing key keeps its errors: 400 INVALID_CURSOR when decoding, a `KeyError` (500) when signing.

Request signatures carry no game label, so the two games must not share a gateway key.

## Counters

Each runtime has its own `OperationCounter`. `build_app` binds a database writer to it and the lifespan stops only that counter. Pokémon's runtime uses the process-wide counter, so importing `app.riftbound_main` no longer rebinds Pokémon's writer. A legacy build with only `connect=` still shares the process counter. Tests that replace a writer do it after the build.

## Composing a new game

1. Write `games/<game>/runtime.py` with its own `connect`, `verify`, `cursor_secret` and a fresh `OperationCounter()`.
2. Mount core routers, or named routes of them chosen with `app.core.routing.only`, which fails at construction on a missing or ambiguous name.
3. Build the entry with `build_app(..., runtime=<GAME>)`.
