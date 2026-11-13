"""Pure, DB-free comparison under the owner's incomplete-update policy (2026-11-11, decision 6).

This is neither an end-to-end suspicious-pull detector nor a writer. The caller must explicitly assess source
quality; unknown and suspicious pulls cannot produce an updated snapshot. There is no default verdict, numeric
threshold, automatic retirement, identity relinking or holdings reassignment. Future persistence must consume
the decision and review holds rather than treating a normaliser result as an accepted generation.
"""
from dataclasses import replace
from typing import Literal, Union

from .model import GroupDecision, GroupResult, GroupSnapshot, PrintingKey
from .normalize import SourceResponseError

PullQuality = Literal['acceptable', 'suspicious', 'unknown']


def compare_group(previous: GroupSnapshot, pull: Union[GroupResult, SourceResponseError, None], *,
                  quality: PullQuality) -> GroupDecision:
    """Compare one pull with the last accepted snapshot, without mutating either input.

    `quality` is a required caller verdict, not a detection mechanism. Failure, suspicion and unknown quality
    return the exact previous snapshot. A successful empty pull is compared using the previous group ID.
    Every observed product counts as present, even if excluded or held under any review flag. Missing products
    remain in the proposed snapshot and are listed for review. Editions are unioned by subtype AND finish;
    vanished price observations are cleared, while unspecified editions are never converted to named finishes.
    No automatic acceptance/persistence of individual review cases is implied by the `compared` status.
    """
    if quality not in ('acceptable', 'suspicious', 'unknown'):
        raise ValueError('quality must be an explicit acceptable, suspicious or unknown verdict')
    if pull is None or isinstance(pull, SourceResponseError):
        return GroupDecision(previous, 'pull_failed')
    if not isinstance(pull, GroupResult):
        raise TypeError('pull must be a GroupResult, SourceResponseError or None')
    if quality != 'acceptable':
        return GroupDecision(previous, 'pull_suspicious' if quality == 'suspicious' else 'quality_unknown')
    if pull.group_id is not None and pull.group_id != previous.group_id:
        raise ValueError('cannot compare different groups')

    old = {p.key: p for p in previous.printings}
    if len(old) != len(previous.printings) or any(key.group_id != previous.group_id for key in old):
        raise ValueError('snapshot must contain unique source keys from its group')
    current = {p.key: p for p in pull.printings}
    review_keys = {PrintingKey(previous.group_id, pid) for item in pull.review for pid in item.product_ids}
    review_keys.update(p.key for p in pull.printings if p.flags or any(e.flags for e in p.editions))
    review_keys.update(p.key for p in pull.excluded)
    present = set(current) | review_keys
    missing = set(old) - present

    # Keep old records not represented by a current catalog candidate, including excluded/held source records.
    merged = dict(old)
    for key, printing in current.items():
        editions = list(printing.editions)
        observed = {(e.subtype, e.finish) for e in editions}
        if key in old:
            editions.extend(replace(e, prices=()) for e in old[key].editions if (e.subtype, e.finish) not in observed)
        merged[key] = replace(printing, editions=tuple(editions))

    def ordered(keys):
        return tuple(sorted(keys, key=lambda key: (key.group_id, key.product_id)))

    review_keys.update(p.key for p in merged.values() if p.flags or any(e.flags for e in p.editions))
    snapshot = GroupSnapshot(previous.group_id, tuple(merged[key] for key in ordered(merged)))
    return GroupDecision(snapshot, 'compared', ordered(missing), ordered(review_keys))
