"""Database-free proof of the report/block fixture's identity normalization."""
import copy
import json

from report_comparison import scrub


def timeline(slot, actor, giver, payer):
    return {'you_are': slot, 'items': [
        {'message': {'from': 'you', 'body': 'high then low'}},
        {'event': {'actor': actor, 'data': {
            'lines': [{'giver': giver, 'edition_id': 'card', 'from_qty': 1, 'to_qty': 2}],
            'cash': {'from': {'payer': payer, 'cents': 100}, 'to': {'payer': None, 'cents': None}},
        }}},
    ]}


def test_equivalent_worlds_keep_the_same_meaning_when_the_reported_collectors_slot_flips():
    high = timeline('high', 'low', 'high', 'low')
    low = timeline('low', 'high', 'low', 'high')
    # This is the old scrubber's failure: timestamps/UUIDs are irrelevant to this difference.
    assert json.dumps(high, sort_keys=True) != json.dumps(low, sort_keys=True)
    assert scrub(high, []) == scrub(low, [])
    assert 'high then low' in scrub(high, [])
    assert high['you_are'] == 'high'  # projection does not mutate the answer


def test_wrong_actor_giver_payer_and_terms_remain_observable():
    high = timeline('high', 'low', 'high', 'low')
    for field in ('actor', 'giver', 'payer', 'quantity'):
        changed = copy.deepcopy(high)
        event = changed['items'][1]['event']
        if field == 'actor':
            event['actor'] = 'high'
        elif field == 'giver':
            event['data']['lines'][0]['giver'] = 'low'
        elif field == 'payer':
            event['data']['cash']['from']['payer'] = 'high'
        else:
            event['data']['lines'][0]['to_qty'] = 3
        assert scrub(changed, []) != scrub(high, []), field


def test_message_order_and_content_are_not_scrubbed_away():
    first = timeline('high', 'low', 'high', 'low')
    changed = copy.deepcopy(first)
    changed['items'].reverse()
    assert scrub(first, []) != scrub(changed, [])
    changed = copy.deepcopy(first)
    changed['items'][0]['message']['body'] = 'Reported'
    assert scrub(first, []) != scrub(changed, [])


def test_each_list_item_retains_its_own_reader_context_and_null_actors_stay_null():
    first = timeline('high', None, 'high', 'low')
    second = timeline('low', None, 'low', 'high')
    assert scrub([first, second], []) == scrub([second, first], [])
    assert '"actor": null' in scrub(first, [])
