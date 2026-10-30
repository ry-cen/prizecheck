"""The Pokémon card art route (#358, ADR 0020): ``GET /api/art/{printing_id}/{size}`` over the core art store, bound to
the Pokémon allowed host and linked-art pattern, with the module-level fetcher."""
import threading

from fastapi import APIRouter, Depends, Path, Query
from fastapi.responses import Response

from app.core.art import store
from app.games.pokemon.art.hosts import ALLOWED_HOST, KEY_PREFIX, LINKED_ART
from app.identity import verified_user

_fetcher: store.ArtFetcher | None = None
_fetcher_lock = threading.Lock()


def fetcher() -> store.ArtFetcher:
    global _fetcher
    with _fetcher_lock:
        if _fetcher is None:
            _fetcher = store.ArtFetcher(allowed_host=ALLOWED_HOST)
        return _fetcher


router = APIRouter(prefix="/api/art")


@router.get("/{printing_id}/{size}", response_class=Response, responses={200: {"content": {"image/webp": {}}}})
async def art(printing_id: str = Path(max_length=64), size: str = Path(max_length=16),
              v: str | None = Query(None, max_length=16), user_id: str = Depends(verified_user)):
    return await store.serve_admitted(printing_id, size, v, allowed_host=ALLOWED_HOST, linked_art=LINKED_ART,
                                      fetcher=fetcher, key_prefix=KEY_PREFIX)
