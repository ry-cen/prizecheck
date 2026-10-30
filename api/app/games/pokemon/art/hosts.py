"""Where Pokémon card art may come from (ADR 0019, ADR 0020): the one host the art route fetches and stores from, and the
shape of the fallback art it only links. Pure constants, passed to the core art store."""
import re

ALLOWED_HOST = "assets.tcgdex.net"
# The first segment of every stored art object key: f"{KEY_PREFIX}/{size}/{id[:2]}/{id}-{digest}". Changing it orphans
# every stored object.
KEY_PREFIX = "tcgdex"
# Fallback art (ADR 0019, #354): linked, never copied. The route answers a redirect to this exact URL shape, which
# the view builds from an integer product id.
LINKED_ART = re.compile(r"https://tcgplayer-cdn\.tcgplayer\.com/product/[0-9]{1,9}_(?:200|400)w\.jpg")

TCGPLAYER_HOST = "tcgplayer-cdn.tcgplayer.com"
TCGPLAYER_LARGE = re.compile(r"https://tcgplayer-cdn\.tcgplayer\.com/product/[0-9]{1,9}_in_1000x1000\.jpg")
TCGPLAYER_KEY_PREFIX = "tcgplayer"


def tcgplayer_beats(base: str, width: int, height: int) -> bool:
    if LINKED_ART.fullmatch(base):
        return width >= 400 and height >= 558
    return width * height > 600 * 825
