"""Pure completeness and validity checks for Riftbound catalog pulls."""
from typing import Optional, Tuple

from .normalize import SourceResponseError, normalise_group
from .plan import GroupInfo, GroupPull, storage_violations

RIFTBOUND_CATEGORY_ID = 89
REASONS = ('fetch_failed', 'response_not_success', 'total_items_mismatch', 'malformed_response',
           'wrong_group', 'wrong_category', 'invalid_id', 'invalid_text', 'invalid_value', 'text_too_long')


def _envelope(payload: object, what: str) -> list:
    if not isinstance(payload, dict):
        raise SourceResponseError(f'{what} response must be an object')
    if payload.get('success') is not True:
        raise SourceResponseError(f'{what} response does not report success')
    if payload.get('errors'):
        raise SourceResponseError(f'{what} response reports errors')
    if not isinstance(payload.get('results'), list):
        raise SourceResponseError(f'{what} response must have a results list')
    return payload['results']


def assess_pull(info: GroupInfo, products: object, prices: object, *,
                fetch_error: Optional[str] = None) -> GroupPull:
    """Accept complete validated responses; retain failures as explicit group holds.

    Exceptions outside the caught normalisation tuple propagate. Types alone do
    not distinguish malformed source data from internal errors of those types.
    """
    if fetch_error is not None:
        return GroupPull(info, None, 'suspicious', {'error': fetch_error if isinstance(fetch_error, str) else repr(fetch_error)}, ('fetch_failed',))
    raw = {'products': products, 'prices': prices}
    reasons = []
    try:
        product_rows = _envelope(products, 'products')
        price_rows = _envelope(prices, 'prices')
    except SourceResponseError as error:
        return GroupPull(info, error, 'suspicious', raw,
                         tuple(sorted({'response_not_success'} | set(storage_violations(info, raw, None)))))
    for payload in (products, prices):
        if 'totalItems' in payload and (type(payload['totalItems']) is not int or
                                       payload['totalItems'] != len(payload['results'])):
            reasons.append('total_items_mismatch')
    codes = storage_violations(info, raw, None)
    if codes:
        return GroupPull(info, None, 'suspicious', raw, tuple(sorted(set(reasons) | set(codes))))
    try:
        result = normalise_group(products, prices)
    except SourceResponseError as error:
        return GroupPull(info, error, 'suspicious', raw,
                         tuple(sorted(set(reasons + ['response_not_success']))))
    except (ValueError, TypeError, KeyError, AttributeError, IndexError):
        return GroupPull(info, None, 'suspicious', raw,
                         tuple(sorted(set(reasons + ['malformed_response']))))
    codes = storage_violations(info, raw, result)
    if codes:
        return GroupPull(info, None, 'suspicious', raw, tuple(sorted(set(reasons) | set(codes))))
    if any(p['groupId'] != info.group_id for p in product_rows):
        reasons.append('wrong_group')
    if any('categoryId' in p and p['categoryId'] != RIFTBOUND_CATEGORY_ID for p in product_rows):
        reasons.append('wrong_category')
    return GroupPull(info, result, 'suspicious' if reasons else 'acceptable', raw,
                     tuple(sorted(set(reasons))))


def listed_groups(payload: object) -> Tuple[GroupInfo, ...]:
    groups = _envelope(payload, 'groups')
    result = []
    for group in groups:
        try:
            if not isinstance(group, dict) or group.get('categoryId') != RIFTBOUND_CATEGORY_ID:
                raise ValueError('invalid category')
            result.append(GroupInfo(group.get('groupId'), group.get('name')))
        except ValueError as error:
            raise ValueError('groups response has an invalid group') from error
    return tuple(sorted(result, key=lambda group: group.group_id))
