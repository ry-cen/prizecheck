"""Card art URLs (#358, ADR 0020): the source rule and the versioned route URL, pure functions with no database and no
FastAPI so catalog_search, catalog_browse and scanner can import them without cycles.

The route is ``GET /api/art/{printing_id}/{size}`` and is keyed by Printing, never by a source URL (D2). The version in
``?v=`` is the first 8 hex characters of the sha256 of the source URL: it changes when the source does, so a browser
that cached the old picture for a year asks again (D2). The route never uses ``v`` to pick bytes: a missing or stale
version still gets the current image, only without the immutable cache header (D3).

Today the only source is TCGdex: the active generation's ``image_url`` plus ``/low.webp`` or ``/high.webp``. #354 and
#360 will move this rule onto ``catalog_printing_art``; ``tcgdex_source`` is the one place to change.
"""
import hashlib

SIZES = {"small": "low.webp", "large": "high.webp"}


def tcgdex_source(image_url: str | None, size: str) -> str | None:
    """The TCGdex file for an image base URL, or None when the Printing has no image."""
    if size not in SIZES:
        raise ValueError(f"unknown art size: {size!r}")
    if not image_url:
        return None
    return f"{image_url.rstrip('/')}/{SIZES[size]}"


def art_version(source_url: str) -> str:
    """8 hex characters that change when the source URL does."""
    return hashlib.sha256(source_url.encode()).hexdigest()[:8]


def art_url(printing_id, image_url: str | None, size: str = "small") -> str | None:
    """The route URL a client should use for a Printing's picture, or None when the Printing has no image."""
    source = tcgdex_source(image_url, size)
    if source is None:
        return None
    return f"/api/art/{printing_id}/{size}?v={art_version(source)}"
