"""Pokémon Collection routes and card facets, composed with game-free inventory reads."""
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel

from app.core.inventory import collection as reads
from app.core.inventory.collection import (CollectionPage, CollectionRevision, CollectionSetList, CollectionTotals,
                                           Distribution, HoldingSort, views)
from app.core.inventory.holdings import HoldingView
from app.identity import verified_user

router = APIRouter(prefix='/api/collection', tags=['collection'])

# The effective attributes, never the old metadata columns, own category and type (migration 041).
FACET_COLUMNS = """CASE ca.card_kind WHEN 'pokemon' THEN 'Pokemon' WHEN 'trainer' THEN 'Trainer' WHEN 'energy' THEN 'Energy' END AS category,
  coalesce(ca.types,'{}') AS elemental_types,ca.trainer_type"""
FACET_JOINS = "  LEFT JOIN catalog_card_attribute ca ON ca.printing_id=p.id"

CardCategory = Literal['Pokemon', 'Trainer', 'Energy']
# Card kind and type come from the effective card attributes, the one source of card type (migration 041), never the
# metadata columns of migration 027.
CARD_KINDS = {'Pokemon': 'pokemon', 'Trainer': 'trainer', 'Energy': 'energy'}
TrainerType = Literal['supporter', 'item', 'tool', 'stadium']
ElementalType = Literal['Colorless', 'Darkness', 'Dragon', 'Fairy', 'Fighting', 'Fire', 'Grass', 'Lightning',
                        'Metal', 'Psychic', 'Water']


def facet_conditions(category, trainer_type, elemental_type):
    conditions, condition_params = "", []
    if category:
        conditions += ' AND ca.card_kind=%s'; condition_params.append(CARD_KINDS[category])
    if trainer_type:
        # A Trainer whose Trainer Type is unknown matches no Trainer Type, only the Trainer category.
        conditions += ' AND ca.trainer_type=%s'; condition_params.append(trainer_type)
    if elemental_type:
        conditions += ' AND %s=ANY(ca.types)'; condition_params.append(elemental_type)
    return conditions, condition_params


def listing_conditions(name, set_id, category, trainer_type, elemental_type):
    """The same composed predicates serve the owned and Borrowed galleries."""
    conditions, params = reads.listing_conditions(name, set_id)
    facets, values = facet_conditions(category, trainer_type, elemental_type)
    return conditions + facets, [*params, *values]


class CollectionHoldingView(HoldingView):
    # Full Location path such as "Shelf / Binder 2"; listing-only, other endpoints keep HoldingView.
    location_path: str
    # From the effective card attributes. Pokemon, Trainer or Energy; null when the card kind is unknown.
    category: str | None
    # A Pokémon's types in printed order; empty for a Trainer or Energy card and when unknown.
    elemental_types: list[str]
    # supporter, item, tool or stadium for a Trainer whose Trainer Type is known; otherwise null.
    trainer_type: str | None


class CollectionHoldingPage(BaseModel):
    snapshot: str
    holdings: list[CollectionHoldingView]
    owner_revision: int
    catalog_revision: int
    next_cursor: str | None = None
    totals: CollectionTotals | None = None
    # With ``totals``: copies lent to Friends (social network #253), in no Location and still the collector's, so the
    # whole Collection's count adds them. "0" for a listing of one Location or with a search or filter, which only
    # Holdings can match.
    lent: str | None = None


@router.get('',response_model=CollectionPage)
def collection(name: str=Query(default='',max_length=120),set_id: str=Query(default='',max_length=80),
               collector_number: str=Query(default='',max_length=40),
               sort: Literal['name','quantity']='name',location_id: UUID | None=None,
               cursor: str | None=Query(default=None,max_length=2048),user_id: str=Depends(verified_user)):
    return reads.collection(name, set_id, collector_number, sort, location_id, cursor, user_id)


@router.get('/editions/{edition_id}',response_model=Distribution)
def distribution(edition_id: UUID,user_id: str=Depends(verified_user)):
    return reads.distribution(edition_id, user_id)


@router.get('/holdings', response_model=CollectionHoldingPage)
def collection_holdings(location_id: UUID | None = None,
                        sort: HoldingSort = 'name-asc',
                        name: str = Query(default='', max_length=120),
                        set_id: str = Query(default='', max_length=80),
                        category: CardCategory | None = None,
                        trainer_type: TrainerType | None = None,
                        elemental_type: ElementalType | None = None,
                        cursor: str | None = Query(default=None, max_length=4096),
                        user_id: str = Depends(verified_user)):
    conditions, params = facet_conditions(category, trainer_type, elemental_type)
    page = reads.collection_holdings(location_id, sort, name, set_id, cursor, user_id,
                                     facet_columns=FACET_COLUMNS, facet_joins=FACET_JOINS,
                                     facet_conditions=conditions, facet_params=params,
                                     facet_context=[category, trainer_type, elemental_type])
    return CollectionHoldingPage(**{**page, 'holdings': views(page['holdings'], CollectionHoldingView)})


@router.get('/sets', response_model=CollectionSetList)
def collection_sets(location_id: UUID | None = None, user_id: str = Depends(verified_user)):
    """The sets of the cards in All owned or one Storage Leaf, once each, for the workspace Set filter.
    Search and filters don't narrow it, so every choice stays offered."""
    return reads.collection_sets(location_id, user_id)


@router.get('/revision', response_model=CollectionRevision)
def collection_revision(user_id: str = Depends(verified_user)):
    """The owner revision alone: one row, no lock. The workspace reads it when a tab regains focus to
    notice changes made elsewhere."""
    return reads.collection_revision(user_id)
