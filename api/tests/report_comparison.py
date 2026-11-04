"""Compare collector-visible answers from equivalent, independently created report/block worlds."""
import json
import re


def _relative_slots(value, you_are=None):
    if isinstance(value, list):
        return [_relative_slots(item, you_are) for item in value]
    if not isinstance(value, dict):
        return value
    slot = value.get('you_are', you_are)
    return {
        key: ('you' if item == slot else 'them')
        if key in ('you_are', 'actor', 'giver', 'payer') and slot in ('low', 'high') and item in ('low', 'high')
        else _relative_slots(item, slot)
        for key, item in value.items()
    }


def scrub(value, names):
    # Slots are ordered account identities, not a report/block outcome. Keep every actor/giver/payer relationship,
    # mapping only typed slot fields relative to this reader. Do not reorder arrays or rewrite message bodies.
    text = re.sub(r'"(cursor|next_before)": "[^"]*"', '"\\1": "<cursor>"',
                  json.dumps(_relative_slots(value), sort_keys=True))
    text = re.sub(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', '<id>', text)
    text = re.sub(r'\d{4}-\d\d-\d\dT[\d:.]+(?:[+-]\d\d:\d\d|Z)?', '<time>', text)
    for name in names:
        text = text.replace(name, '<name>')
    return text
