"""Revision-fenced art sidecars. Legacy marketplace records remain unchanged."""
import os
import time

from app.public_projection import ProjectionUnavailable, public_record_store
from app.public_records import catalog_edition_key, edition_art_key
from .public import REF
from .urls import art_version

PREFIX = '/api/public/edition-art/'
ART_PREFIX = 'art:edition:'


def sidecars_enabled():
    # Older HTTP relays reject unknown key families. Keep their entire legacy
    # publication/read path unchanged until relay support is explicitly enabled.
    return (os.environ.get('PUBLIC_PROJECTION_ADAPTER', 'filesystem') != 'http'
            or os.environ.get('PUBLIC_ART_SIDECARS', '').strip().lower() == 'on')


def selection(value, record):
    if not isinstance(value, dict) or set(value) != {
            'version', 'edition_ref', 'printing_ref', 'mapping_revision', 'revision',
            'product_id', 'mode', 'descriptor', 'set_id', 'collector_number', 'reference_small', 'reference_large'}:
        return None
    market = record.get('marketplace')
    if (not isinstance(market, dict)
            or any(not isinstance(record.get(key), str) or not REF.fullmatch(record[key])
                   or value[key] != record[key] for key in ('edition_ref', 'printing_ref'))
            or type(value['revision']) is not int or value['revision'] <= 0
            or type(record.get('revision')) is not int or value['revision'] != record['revision']
            or type(value['mapping_revision']) is not int or value['mapping_revision'] <= 0
            or type(market.get('mapping_revision')) is not int or value['mapping_revision'] != market['mapping_revision']
            or value['descriptor'] != record.get('descriptor')
            or not isinstance(value['descriptor'], dict)
            or not isinstance(value['set_id'], str) or not isinstance(value['collector_number'], str)
            or value['mode'] not in ('linked', 'reference', 'withheld', 'printing')):
        return None
    if any(value[key] is not None and (not isinstance(value[key], str) or len(value[key]) > 2048)
           for key in ('reference_small', 'reference_large')):
        return None
    if value['mode'] != 'reference' and any(value[key] is not None for key in ('reference_small', 'reference_large')):
        return None
    product = value['product_id']
    if value['mode'] == 'linked':
        if type(product) is not int or not 0 < product <= 999999999:
            return None
        version = art_version(f"edition-linked:{product}:{value['mapping_revision']}:{value['revision']}")
    else:
        if product is not None:
            return None
        version = art_version(f"edition-art:{value['mode']}:{value['mapping_revision']}:{value['revision']}")
    return value if value['version'] == version else None


def read_selections(refs, *, deadline=None):
    refs = {ref for ref in refs if isinstance(ref, str) and REF.fullmatch(ref)}
    if not refs or not sidecars_enabled():
        return {}
    try:
        keys = [key for ref in refs for key in (catalog_edition_key(ref), edition_art_key(ref))]
        records = public_record_store().read_all(keys,
                    deadline=deadline if deadline is not None else time.monotonic() + 2).records
        result = {}
        for ref in refs:
            parent = records[catalog_edition_key(ref)].value
            if isinstance(parent, dict) and parent.get('edition_ref') == ref:
                result[ref] = selection(records[edition_art_key(ref)].value, parent)
        return result
    except (ProjectionUnavailable, KeyError, TypeError, ValueError):
        return {}


def address(ref, art, size):
    return f'{PREFIX}{ref}/{size}?v={art["version"]}'
