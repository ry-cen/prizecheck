"""Bounded Pokémon Center imagery and legacy public snapshot selection."""
from app.core.art.editions import PREFIX, address
from app.core.art.public import public_address
from app.core.art.store import host_allowed
from .hosts import ALLOWED_HOST, TCGPLAYER_KEY_PREFIX
from .scope import physical, number, regular_reference
from app.games.pokemon.publications.public_deck import printing_matches


def pokemon_center(descriptor):
    stamp = descriptor.get('stamp') if isinstance(descriptor, dict) else None
    return stamp == 'pokemon-center' or isinstance(stamp, list) and 'pokemon-center' in stamp


def public_images(ref, printing_ref, descriptor, direct, large_direct, reviewed, *, excluded_prefixes,
                  set_id=None, collector_number=None):
    selected = reviewed.get(ref)
    safe_reference = regular_reference(set_id, collector_number, descriptor)
    # Printing mode selects no new Edition art. Keep its original fallback even
    # when active-generation display fields disappear during source withdrawal.
    if selected is not None and selected['mode'] != 'printing':
        # An internally consistent current record is not proof that it belongs to
        # this frozen row. Compare Printing and physical identity before using it.
        if (not printing_matches(printing_ref, selected['printing_ref'])
                or physical(descriptor) != physical(selected['descriptor'])
                or (set_id or '').casefold() != selected['set_id'].casefold()
                or number(collector_number) != number(selected['collector_number'])):
            return None, None
        if selected['mode'] == 'linked':
            return address(ref, selected, 'small'), address(ref, selected, 'large')
        if selected['mode'] == 'withheld':
            return None, None
        if selected['mode'] == 'reference':
            small, large = selected['reference_small'], selected['reference_large']
            if not all(host_allowed(url or '', allowed_host=ALLOWED_HOST) for url in (small, large)):
                return None, None
            return small, large
    if ((set_id or '').casefold() == 'svp' and pokemon_center(descriptor)) or (direct or '').startswith(PREFIX):
        return None, None
    # This invariant comes from the frozen scoped identity, not availability of
    # sidecars/PC config. Missing or withdrawn metadata never permits a PC upgrade.
    excluded = tuple(set(excluded_prefixes) | ({TCGPLAYER_KEY_PREFIX} if safe_reference else set()))
    if safe_reference and not host_allowed(direct or '', allowed_host=ALLOWED_HOST):
        direct = large_direct = None
    return (public_address(printing_ref, 'small', excluded_prefixes=excluded) or direct,
            public_address(printing_ref, 'large', excluded_prefixes=excluded) or large_direct)
