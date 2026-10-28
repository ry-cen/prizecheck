"""Card art URLs (#358, ADR 0020): the source rule and the versioned route URL, pure functions with no database and no
FastAPI so catalog_search, catalog_browse and scanner can import them without cycles.

The route is ``GET /api/art/{printing_id}/{size}`` and is keyed by Printing, never by a source URL (D2). The version in
``?v=`` is the first 8 hex characters of the sha256 of the Printing's small source URL, for both sizes (the two files
change together, so a client that asks for the other size by changing the size in the path keeps a version the route
accepts): it changes when the source does, so a browser
that cached the old picture for a year asks again (D2). The route never uses ``v`` to pick bytes: a missing or stale
version still gets the current image, only without the immutable cache header (D3).

A Printing's art comes from one place, the ``catalog_printing_art`` view (TCGdex first, then the fallback). Signed-in
reads select the view's ``small_art_url`` and ``large_art_url`` (migration 158, built by ``catalog_art_route``, the SQL
twin of ``art_url`` below); the route's resolver reads the view's source URLs. The scanner is the exception that stays on
TCGdex (its page cannot load other hosts), so ``tcgdex_source`` and ``art_url`` serve the scanner and nothing else.
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


def route_address(printing_id, small_source: str | None, size: str = "small") -> str | None:
    """The route address for a Printing from the view's small source URL (``catalog_printing_art.low_image_url``), the
    Python twin of ``catalog_art_route``. List reads over many rows select the raw source and call this on the page's rows
    only, so the version is not hashed for every catalog row."""
    if size not in SIZES:
        raise ValueError(f"unknown art size: {size!r}")
    if not small_source:
        return None
    return f"/api/art/{printing_id}/{size}?v={art_version(small_source)}"


def large_direct_url(small_url: str | None) -> str | None:
    """The large file for a direct small address (TCGdex ``/low.webp``, TCGplayer ``_200w.jpg``), or None. Anonymous
    pages cannot use the art route, so they get direct addresses for both sizes."""
    if not small_url:
        return None
    if small_url.endswith("/low.webp"):
        return small_url[: -len("low.webp")] + SIZES["large"]
    if small_url.endswith("_200w.jpg"):
        return small_url[: -len("_200w.jpg")] + "_400w.jpg"
    return None


def art_version(source_url: str) -> str:
    """8 hex characters that change when the source URL does."""
    return hashlib.sha256(source_url.encode()).hexdigest()[:8]


def art_url(printing_id, image_url: str | None, size: str = "small") -> str | None:
    """The route URL a client should use for a Printing's picture, or None when the Printing has no image."""
    source = tcgdex_source(image_url, size)
    if source is None:
        return None
    return f"/api/art/{printing_id}/{size}?v={art_version(tcgdex_source(image_url, 'small'))}"
