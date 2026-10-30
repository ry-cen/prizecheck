"""Card art URLs (#358, ADR 0020), the Pokémon half: the TCGdex source rule and the route URL built from it. The scanner is
the exception that stays on TCGdex (its page cannot load other hosts), so ``tcgdex_source`` and ``art_url`` serve the
scanner and the Catalog browse; the sizes, ``route_address`` and ``art_version`` are in ``app.core.art.urls``.
"""
from app.core.art.urls import SIZES, art_version


def tcgdex_source(image_url: str | None, size: str) -> str | None:
    """The TCGdex file for an image base URL, or None when the Printing has no image."""
    if size not in SIZES:
        raise ValueError(f"unknown art size: {size!r}")
    if not image_url:
        return None
    return f"{image_url.rstrip('/')}/{SIZES[size]}"


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


def art_url(printing_id, image_url: str | None, size: str = "small") -> str | None:
    """The route URL a client should use for a Printing's picture, or None when the Printing has no image."""
    source = tcgdex_source(image_url, size)
    if source is None:
        return None
    return f"/api/art/{printing_id}/{size}?v={art_version(tcgdex_source(image_url, 'small'))}"
