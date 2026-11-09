"""Deterministic generated arithmetic contracts for the pure allocation public facade.

Each seed builds three Decks, two Editions and five Holding locations. Cross every
world with absent/partial/full reservations and current/moved/deleted pick sources.
Moved picks may be stale; reservation counts still never exceed owned Holdings.
"""
from collections import Counter
from copy import deepcopy
from itertools import product
from random import Random
from typing import get_args

import pytest

from app.copy_allocation import AllocationRows, allocate_rows
from app.settings import WantListCounting
from test_allocate_rows import E, F, OLD, MID, NEW, OTHER, LOOSE, figures, rows

DECKS = (OLD, MID, NEW)
PLACES = (*DECKS, OTHER, LOOSE)
EDITIONS = (E, F)


def generated_rows(seed, reservation, placement) -> AllocationRows:
    rng = Random(seed)
    holdings = tuple((place, edition, copies) for place, edition in product(PLACES, EDITIONS)
                     if (copies := rng.randrange(5)))
    lines = tuple((deck, edition, rng.randrange(1, 10)) for deck, edition in product(DECKS, EDITIONS))
    # Borrowed and lent copies belong to distinct physical stocks from Holdings.
    borrowed = {(deck, edition): copies for deck, edition in product(DECKS, EDITIONS)
                if (copies := rng.randrange(4))}
    lent_at = {}
    for edition in EDITIONS:
        sources = Counter(rng.choice((*PLACES, None)) for _ in range(rng.randrange(7)))
        if sources:
            lent_at[edition] = dict(sources)
    reserved, picked = {}, {}
    for edition in EDITIONS:
        stock = [place for place, held_edition, copies in holdings if held_edition == edition
                 for _ in range(copies)]
        quantity = 0 if reservation == 'none' else len(stock) if reservation == 'all' else len(stock) // 2
        if not quantity:
            continue
        reserved[edition] = quantity
        selected = rng.sample(stock, quantity)
        if placement == 'moved':
            selected = [PLACES[(PLACES.index(place) + 1) % len(PLACES)] for place in selected]
        elif placement == 'deleted':
            selected = [None] * quantity
        picked[edition] = dict(Counter(selected))
    return rows(holdings, lines, reserved=reserved, picked=picked,
                borrowed=borrowed, lent_at=lent_at,
                lent={edition: sum(sources.values()) for edition, sources in lent_at.items()})


@pytest.mark.parametrize('seed', range(48))
@pytest.mark.parametrize('counting', get_args(WantListCounting))
def test_generated_allocation_conserves_each_line_and_never_changes_inputs(seed, counting):
    for reservation, placement in product(('none', 'partial', 'all'), ('current', 'moved', 'deleted')):
        context = (seed, counting, reservation, placement)
        inputs = generated_rows(seed, reservation, placement)
        before = deepcopy(inputs)
        editions = list(EDITIONS)
        expected_lines = {(deck, edition): quantity for deck, edition, quantity in inputs.lines}
        allocation = allocate_rows(inputs, editions, counting)
        # Reuse the existing identity assertion; no expected arithmetic is computed by a second allocator.
        components = figures(allocation)
        assert set(components) == set(expected_lines), context
        for key, quantities in components.items():
            line = allocation.lines[key]
            assert line.quantity == expected_lines[key], context
            assert all(quantity >= 0 for quantity in quantities), (context, key, quantities)
            assert line.borrowed <= inputs.borrowed.get(key, 0), (context, key)
            assert sum(quantity for _, quantity in line.from_decks) == line.other_decks, (context, key)
            assert all(deck != line.deck_id and quantity > 0 for deck, quantity in line.from_decks), (context, key)
            if counting == 'all_at_once':
                assert line.other_decks == 0 and line.from_decks == (), (context, key)
        for edition, copies in allocation.copies.items():
            reserved = inputs.reserved.get(edition, 0)
            assert 0 <= reserved <= copies.total, context
            assert sum(copies.reserved_beyond.values()) + sum(copies.reserved_own.values()) == reserved, context
            for placed, capacity in ((copies.reserved_beyond, copies.beyond), (copies.reserved_own, copies.own)):
                assert all(0 < quantity <= capacity[place] for place, quantity in placed.items()), context
            assert copies.spare >= 0, context
        assert inputs == before, context
        assert editions == list(EDITIONS), context
        # Repeated reads must produce the same result without mutating nested pick/loan maps.
        assert allocate_rows(inputs, editions, counting) == allocation, context
        assert inputs == before, context
