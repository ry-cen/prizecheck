"""The Pokémon card art route (#358, ADR 0020): ``GET /api/art/{printing_id}/{size}`` over the core art store, bound to
the Pokémon allowed host and linked-art pattern, with the module-level fetcher."""
import os
import threading

from fastapi import APIRouter, Depends, Path, Query
from fastapi.responses import Response

from app.core.art import store
from app.games.pokemon.art.hosts import ALLOWED_HOST, KEY_PREFIX, LINKED_ART, TCGPLAYER_HOST, TCGPLAYER_LARGE, TCGPLAYER_KEY_PREFIX, tcgplayer_beats
from app.identity import verified_user
from app.core.art.public import serve_public

_fetcher: store.ArtFetcher | None = None
_fetcher_lock = threading.Lock()


def fetcher() -> store.ArtFetcher:
    global _fetcher
    with _fetcher_lock:
        if _fetcher is None:
            _fetcher = store.ArtFetcher(allowed_host=ALLOWED_HOST)
        return _fetcher


_tcgplayer_fetcher: store.ArtFetcher | None = None


def tcgplayer_fetcher() -> store.ArtFetcher:
    global _tcgplayer_fetcher
    with _fetcher_lock:
        if _tcgplayer_fetcher is None:
            _tcgplayer_fetcher = store.ArtFetcher(allowed_host=TCGPLAYER_HOST, path_pattern=TCGPLAYER_LARGE)
        return _tcgplayer_fetcher


def tcgplayer_source_enabled() -> bool:
    return os.environ.get("ART_TCGPLAYER_SOURCE", "").strip().lower() in ("", "on")


def upgrade() -> store.LargeUpgrade | None:
    return (store.LargeUpgrade(TCGPLAYER_HOST, TCGPLAYER_LARGE, tcgplayer_fetcher,
                              TCGPLAYER_KEY_PREFIX, tcgplayer_beats) if tcgplayer_source_enabled() else None)


router = APIRouter(prefix="/api/art")


@router.get("/{printing_id}/{size}", response_class=Response, responses={200: {"content": {"image/webp": {}}}})
async def art(printing_id: str = Path(max_length=64), size: str = Path(max_length=16),
              v: str | None = Query(None, max_length=16), user_id: str = Depends(verified_user)):
    return await store.serve_admitted(printing_id, size, v, allowed_host=ALLOWED_HOST, linked_art=LINKED_ART,
                                      fetcher=fetcher, key_prefix=KEY_PREFIX, upgrade=upgrade())


def excluded_prefixes() -> tuple:
    return () if tcgplayer_source_enabled() else (TCGPLAYER_KEY_PREFIX,)


public_router = APIRouter()


@public_router.get("/api/public/art/{printing_ref}/{size}", response_class=Response,
                   responses={200: {"content": {"image/webp": {}, "image/jpeg": {}}}})
def public_art(printing_ref: str = Path(max_length=64), size: str = Path(max_length=16),
               v: str | None = Query(None, max_length=16)):
    return serve_public(printing_ref, size, v, excluded_prefixes=excluded_prefixes())
