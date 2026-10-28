"""Derived Collection totals; no mutable summary inventory."""
from decimal import Decimal
from uuid import UUID
from fastapi import APIRouter, Depends, Query, HTTPException
from typing import Literal
import base64, hashlib, hmac, json, os
from pydantic import BaseModel
from .art_urls import route_address
from .db import connect
from .identity import verified_user
from .holdings import HoldingView, fail
from .social import counts

router = APIRouter(prefix='/api/collection', tags=['collection'])

class CollectionEntry(BaseModel):
    edition_id: UUID
    quantity: str
    printing_id: UUID
    printing_name: str
    set_id: str
    set_name: str
    collector_number: str
    descriptor: dict
    image_url: str | None

class CollectionPage(BaseModel):
    entries: list[CollectionEntry]
    owner_revision: int
    catalog_revision: int
    next_cursor: str | None = None

class Distribution(BaseModel):
    holdings: list[HoldingView]

COLUMNS = """e.id AS edition_id,e.printing_id,coalesce(pd.display_name,ci.display_name) AS printing_name,
 coalesce(pd.set_id,'') AS set_id,coalesce(pd.set_name,'') AS set_name,
 coalesce(pd.collector_number,'') AS collector_number,e.descriptor,art.low_image_url AS art_source"""
JOINS = """JOIN catalog_edition e ON e.id=h.edition_id
 JOIN catalog_printing p ON p.id=e.printing_id JOIN catalog_identity ci ON ci.id=p.identity_id
 LEFT JOIN catalog_printing_display pd ON pd.printing_id=p.id
 LEFT JOIN catalog_printing_art art ON art.printing_id=p.id
 LEFT JOIN catalog_generation_printing gp ON gp.printing_id=p.id AND gp.generation_id=%s"""

def views(rows, model=HoldingView):
    """The page's rows as views. Rows carry the art source, not the address: the route address (ADR 0020) is built here,
    for the page only, so a large Collection does not hash a version for every catalog row."""
    return [model(**{**{key:value for key,value in row.items() if key!='art_source'},'quantity':str(row['quantity']),
             'image_url':route_address(row['printing_id'],row['art_source'])}) for row in rows]

def encode_cursor(context, key):
    data=json.dumps({'context':context,'key':key},separators=(',',':')).encode()
    signature=hmac.new(os.environ['INTERNAL_AUTH_SECRET'].encode(),data,hashlib.sha256).digest()
    return base64.urlsafe_b64encode(data+signature).decode().rstrip('=')


def cursor_key(token,context):
    """The key of a cursor signed for this context. 409 when only a revision moved; otherwise 400 INVALID_CURSOR."""
    try:
        raw=base64.urlsafe_b64decode(token+'='*(-len(token)%4))
        data,signature=raw[:-32],raw[-32:]
        if not hmac.compare_digest(signature,hmac.new(os.environ['INTERNAL_AUTH_SECRET'].encode(),data,hashlib.sha256).digest()):
            raise ValueError
        payload=json.loads(data)
        old=payload['context']
        if old[:-2]!=context[:-2]: raise ValueError
        if old[-2]!=context[-2]: fail(409,'INVENTORY_CHANGED')
        if old[-1]!=context[-1]: fail(409,'CATALOG_CHANGED')
        return payload['key']
    except HTTPException: raise
    except (ValueError,KeyError,TypeError,UnicodeDecodeError): fail(400,'INVALID_CURSOR')


def decode_cursor(token,context):
    """The Collection page cursor: [sort value, Edition id]."""
    key=cursor_key(token,context)
    try:
        if not isinstance(key,list) or len(key)!=2: raise ValueError
        UUID(key[1])
        return key
    except (ValueError,TypeError,AttributeError): fail(400,'INVALID_CURSOR')


@router.get('',response_model=CollectionPage)
def collection(name: str=Query(default='',max_length=120),set_id: str=Query(default='',max_length=80),
               collector_number: str=Query(default='',max_length=40),
               sort: Literal['name','quantity']='name',location_id: UUID | None=None,
               cursor: str | None=Query(default=None,max_length=2048),user_id: str=Depends(verified_user)):
    with connect() as conn, conn.transaction():
        # A repeatable snapshot binds metadata, totals, and revisions to one view.
        conn.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
        state=conn.execute('SELECT active_generation,revision FROM catalog_state WHERE singleton').fetchone()
        owner=conn.execute('SELECT revision FROM inventory_owner WHERE user_id=%s',(user_id,)).fetchone()
        revision=owner['revision'] if owner else 1
        name=name.strip().lower(); set_id=set_id.strip().lower(); collector_number=collector_number.strip().lower()
        context=[user_id,str(location_id) if location_id else None,name,set_id,collector_number,sort,revision,state['revision']]
        key=decode_cursor(cursor,context) if cursor else None
        scope=''; params=[state['active_generation'],user_id]
        if location_id:
            if not conn.execute('SELECT 1 FROM location WHERE owner_id=%s AND id=%s',(user_id,location_id)).fetchone():
                fail(404,'LOCATION_NOT_FOUND')
            scope=""" AND h.location_id IN (WITH RECURSIVE descendants AS (
              SELECT id FROM location WHERE owner_id=%s AND id=%s UNION ALL
              SELECT l.id FROM location l JOIN descendants d ON l.parent_id=d.id WHERE l.owner_id=%s)
              SELECT id FROM descendants)"""
            params.extend([user_id,location_id,user_id])
        filters=''
        if name:
            filters+=" AND coalesce(lower(pd.display_name),lower(ci.display_name)) LIKE %s ESCAPE '!'"
            params.append(name.replace('!','!!').replace('%','!%').replace('_','!_')+'%')
        if set_id: filters+=' AND lower(pd.set_id)=%s'; params.append(set_id)
        if collector_number: filters+=' AND lower(pd.collector_number)=%s'; params.append(collector_number)
        after=''
        order='search_name,edition_id' if sort=='name' else 'quantity DESC,edition_id'
        if key:
            if sort=='name': after='WHERE (search_name,edition_id)>(%s,%s)'; params.extend([key[0],UUID(key[1])])
            else:
                after='WHERE quantity<%s OR (quantity=%s AND edition_id>%s)'
                try: amount=int(key[0])
                except (ValueError,TypeError): fail(400,'INVALID_CURSOR')
                params.extend([amount,amount,UUID(key[1])])
        rows=conn.execute(f"""WITH totals AS (SELECT {COLUMNS},sum(h.quantity) AS quantity,
          coalesce(lower(pd.display_name),lower(ci.display_name)) AS search_name
          FROM holding h {JOINS} WHERE h.owner_id=%s {scope} {filters}
          GROUP BY e.id,ci.id,pd.printing_id,gp.generation_id,gp.printing_id,art.low_image_url)
          SELECT * FROM totals {after} ORDER BY {order} LIMIT 31""",params).fetchall()
        page=rows[:30]
        next_cursor=encode_cursor(context,[str(page[-1]['quantity']) if sort=='quantity' else page[-1]['search_name'],str(page[-1]['edition_id'])]) if len(rows)>30 else None
        return CollectionPage(entries=views(page,CollectionEntry),owner_revision=revision,catalog_revision=state['revision'],next_cursor=next_cursor)

@router.get('/editions/{edition_id}',response_model=Distribution)
def distribution(edition_id: UUID,user_id: str=Depends(verified_user)):
    with connect() as conn:
        state=conn.execute('SELECT active_generation FROM catalog_state WHERE singleton').fetchone()
        rows=conn.execute(f"""SELECT {COLUMNS},h.quantity,h.version,h.location_id,l.name AS location_name
         FROM holding h JOIN location l ON l.id=h.location_id AND l.owner_id=h.owner_id {JOINS}
         WHERE h.owner_id=%s AND h.edition_id=%s ORDER BY l.name,l.id""",
         (state['active_generation'],user_id,edition_id)).fetchall()
        return Distribution(holdings=views(rows))


# Holding-level listing for the collector workspace gallery (tickets #103 and #104).
# One row per Holding (Storage Leaf + Card Edition), never per copy: the client expands quantities into tiles.
HOLDING_PAGE_SIZE = 500
# Full Location paths such as "Shelf / Binder 2". The depth guard only stops a corrupt cycle;
# Location commands already cap the tree at 12 levels.
HOLDING_PATHS = """WITH RECURSIVE paths AS (
  SELECT id,name::text AS path,1 AS depth FROM location WHERE owner_id=%s AND parent_id IS NULL
  UNION ALL
  SELECT child.id,parent.path||' / '||child.name,parent.depth+1
  FROM location child JOIN paths parent ON child.parent_id=parent.id
  WHERE child.owner_id=%s AND parent.depth<32)"""
# Every sort key is NOT NULL: a NULL would drop rows from the keyset comparison.
# edition_total is the Card Edition's copies within the listed rows (the view after search and filters).
HOLDING_COLUMNS = """h.edition_id,h.location_id,l.name AS location_name,coalesce(lp.path,l.name) AS location_path,h.quantity,h.version,
  p.id AS printing_id,coalesce(pd.display_name,ci.display_name) AS printing_name,
  coalesce(pd.set_id,'') AS set_id,coalesce(pd.set_name,'') AS set_name,
  coalesce(pd.collector_number,'') AS collector_number,e.descriptor,art.low_image_url AS art_source,
  CASE ca.card_kind WHEN 'pokemon' THEN 'Pokemon' WHEN 'trainer' THEN 'Trainer' WHEN 'energy' THEN 'Energy' END AS category,
  coalesce(ca.types,'{}') AS elemental_types,ca.trainer_type,
  coalesce(lower(pd.display_name),lower(ci.display_name)) AS search_name,
  lower(coalesce(lp.path,l.name)) AS location_key,
  lower(coalesce(pd.set_name,'')) AS set_key,
  substring(coalesce(pd.collector_number,'') from '^[0-9]+') IS NULL AS number_missing,
  coalesce(substring(pd.collector_number from '^[0-9]+')::numeric,0) AS number_value,
  lower(coalesce(pd.collector_number,'')) AS number_key,
  sum(h.quantity) OVER (PARTITION BY h.edition_id) AS edition_total"""
HOLDING_FROM = """FROM holding h JOIN location l ON l.id=h.location_id AND l.owner_id=h.owner_id
  LEFT JOIN paths lp ON lp.id=h.location_id
  JOIN catalog_edition e ON e.id=h.edition_id
  JOIN catalog_printing p ON p.id=e.printing_id
  JOIN catalog_identity ci ON ci.id=p.identity_id
  LEFT JOIN catalog_printing_display pd ON pd.printing_id=p.id
  LEFT JOIN catalog_printing_art art ON art.printing_id=p.id
  LEFT JOIN catalog_card_attribute ca ON ca.printing_id=p.id
  WHERE h.owner_id=%s"""
HoldingSort = Literal['name-asc', 'name-desc', 'set-asc', 'set-desc', 'quantity-asc', 'quantity-desc']
CardCategory = Literal['Pokemon', 'Trainer', 'Energy']
# Card kind and type come from the effective card attributes, the one source of card type (migration 041), never the
# metadata columns of migration 027.
CARD_KINDS = {'Pokemon': 'pokemon', 'Trainer': 'trainer', 'Energy': 'energy'}
TrainerType = Literal['supporter', 'item', 'tool', 'stadium']
ElementalType = Literal['Colorless', 'Darkness', 'Dragon', 'Fairy', 'Fighting', 'Fire', 'Grass', 'Lightning',
                        'Metal', 'Psychic', 'Water']
# Copies of one Card Edition stay together and in source Location order, whatever the sort and direction.
LOCATION_KEYS = (('location_key', False), ('location_id', False))


def holding_keys(sort):
    """(column, descending) sort keys. Every key before edition_id is a Card Edition attribute, so an
    Edition's Holdings stay adjacent; the Location keys always ascend."""
    key, direction = sort.split('-')
    down = direction == 'desc'
    if key == 'set':
        edition = (('set_key', down), ('set_id', down), ('number_missing', down), ('number_value', down),
                   ('number_key', down), ('edition_id', down))
    elif key == 'quantity':
        # Ties read A–Z in both directions.
        edition = (('edition_total', down), ('search_name', False), ('edition_id', False))
    else:
        edition = (('search_name', down), ('edition_id', down))
    return edition + LOCATION_KEYS


def keyset_after(keys):
    """The rows after an anchor row under a mixed-direction ORDER BY: an OR of prefix comparisons.
    Returns the WHERE clause and, in placeholder order, the anchor columns to bind."""
    terms, columns = [], []
    for index, (column, descending) in enumerate(keys):
        equal = [f'{name}=%s' for name, _ in keys[:index]]
        terms.append('(' + ' AND '.join([*equal, f"{column}{'<' if descending else '>'}%s"]) + ')')
        columns += [name for name, _ in keys[:index]] + [column]
    return 'WHERE ' + ' OR '.join(terms), columns


# A holding cursor carries the last row's sort values, so the next page never re-runs the listing to find
# its anchor. The signed context binds both revisions, so the values are still current when it returns.
# The Location path is left out (up to 12 × 120 characters); the next page re-reads it for one Location.
ANCHOR_TYPES = {'edition_id': UUID, 'location_id': UUID, 'number_missing': bool,
                'number_value': Decimal, 'edition_total': Decimal}


def anchor_columns(keys):
    """The sort columns a holding cursor carries, in key order."""
    return [column for column, _ in keys if column != 'location_key']


def anchor_json(value):
    return value if isinstance(value, (bool, str)) else str(value)


def anchor_value(column, raw):
    """One carried sort value, back in the type the listing compares it as. Raises on a wrong shape."""
    kind = ANCHOR_TYPES.get(column, str)
    if kind is bool:
        if not isinstance(raw, bool):
            raise ValueError
        return raw
    if not isinstance(raw, str):
        raise ValueError
    if kind is Decimal:
        value = Decimal(raw)
        if not value.is_finite():
            raise ValueError
        return value
    return UUID(raw) if kind is UUID else raw


class CollectionTotals(BaseModel):
    holdings: int
    editions: int
    copies: str


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
    holdings: list[CollectionHoldingView]
    owner_revision: int
    catalog_revision: int
    next_cursor: str | None = None
    totals: CollectionTotals | None = None
    # With ``totals``: copies lent to Friends (social network #253), in no Location and still the collector's, so the
    # whole Collection's count adds them. "0" for a listing of one Location or with a search or filter, which only
    # Holdings can match.
    lent: str | None = None


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
    with connect() as conn, conn.transaction():
        # One repeatable snapshot binds rows, totals and both revisions.
        conn.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
        state = conn.execute('SELECT revision FROM catalog_state WHERE singleton').fetchone()
        attributes = conn.execute('SELECT revision FROM catalog_attribute_state WHERE singleton').fetchone()
        owner = conn.execute('SELECT revision FROM inventory_owner WHERE user_id=%s', (user_id,)).fetchone()
        revision = owner['revision'] if owner else 1
        if location_id:
            leaf = conn.execute('SELECT kind FROM location WHERE owner_id=%s AND id=%s', (user_id, location_id)).fetchone()
            if not leaf:
                fail(404, 'LOCATION_NOT_FOUND')
            if leaf['kind'] not in ('storage_leaf', 'deck'):
                fail(409, 'NOT_STORAGE_LEAF')
        name, set_id = name.strip().lower(), set_id.strip()
        # Slot 3 is the sort; the search and filter values sit before the two revisions. The last slot binds the
        # catalog and the card attribute revisions together: an attribute decision moves cards between filters, so a
        # cursor from before it answers 409 CATALOG_CHANGED and the gallery starts again.
        context = ['collection-holdings', user_id, str(location_id) if location_id else None, sort,
                   name, set_id, category, trainer_type, elemental_type, revision,
                   [state['revision'], attributes['revision']]]
        conditions, condition_params = '', []
        if location_id:
            conditions += ' AND h.location_id=%s'; condition_params.append(location_id)
        if name:
            conditions += " AND coalesce(lower(pd.display_name),lower(ci.display_name)) LIKE %s ESCAPE '!'"
            condition_params.append('%' + name.replace('!', '!!').replace('%', '!%').replace('_', '!_') + '%')
        if set_id:
            conditions += ' AND pd.set_id=%s'; condition_params.append(set_id)
        if category:
            conditions += ' AND ca.card_kind=%s'; condition_params.append(CARD_KINDS[category])
        if trainer_type:
            # A Trainer whose Trainer Type is unknown matches no Trainer Type, only the Trainer category.
            conditions += ' AND ca.trainer_type=%s'; condition_params.append(trainer_type)
        if elemental_type:
            conditions += ' AND %s=ANY(ca.types)'; condition_params.append(elemental_type)
        base = [user_id, user_id, user_id, *condition_params]
        # Filters apply inside, so edition_total counts only the listed rows; anchors and pages filter outside.
        listed = f'SELECT {HOLDING_COLUMNS} {HOLDING_FROM}{conditions}'
        keys = holding_keys(sort)
        order = ','.join(f"{column} {'DESC' if descending else 'ASC'}" for column, descending in keys)
        after, after_params = '', []
        if cursor:
            carried = anchor_columns(keys)
            key = cursor_key(cursor, context)
            try:
                if not isinstance(key, list) or len(key) != len(carried):
                    raise ValueError
                anchor = {column: anchor_value(column, raw) for column, raw in zip(carried, key)}
            except (ValueError, TypeError, ArithmeticError):
                fail(400, 'INVALID_CURSOR')
            # The anchor's Location path, from the Location tree alone; the revision check above guarantees
            # that Location still exists under the same path.
            place = conn.execute(f"""{HOLDING_PATHS} SELECT lower(coalesce(lp.path,l.name)) AS location_key
              FROM location l LEFT JOIN paths lp ON lp.id=l.id WHERE l.owner_id=%s AND l.id=%s""",
                                 [user_id, user_id, user_id, anchor['location_id']]).fetchone()
            if not place:
                fail(409, 'INVENTORY_CHANGED')
            anchor['location_key'] = place['location_key']
            after, columns = keyset_after(keys)
            after_params = [anchor[column] for column in columns]
        rows = conn.execute(f"""{HOLDING_PATHS} SELECT * FROM ({listed}) listed
          {after} ORDER BY {order} LIMIT %s""", [*base, *after_params, HOLDING_PAGE_SIZE + 1]).fetchall()
        page = rows[:HOLDING_PAGE_SIZE]
        totals, lent = None, None
        if not cursor:
            counted = conn.execute(f"""{HOLDING_PATHS} SELECT count(*) AS holdings,
              count(DISTINCT h.edition_id) AS editions,coalesce(sum(h.quantity),0) AS copies
              {HOLDING_FROM}{conditions}""", base).fetchone()
            whole = location_id is None and not (name or set_id or category or trainer_type or elemental_type)
            lent = str(sum(counts.lent_counts(conn, user_id, None).values()) if whole else 0)
            totals = CollectionTotals(holdings=counted['holdings'], editions=counted['editions'],
                                      copies=str(counted['copies']))
        next_cursor = (encode_cursor(context, [anchor_json(page[-1][column]) for column in anchor_columns(keys)])
                       if len(rows) > HOLDING_PAGE_SIZE else None)
        return CollectionHoldingPage(holdings=views(page, CollectionHoldingView), owner_revision=revision,
                                     catalog_revision=state['revision'], next_cursor=next_cursor, totals=totals,
                                     lent=None if totals is None else lent)


class CollectionSet(BaseModel):
    set_id: str
    set_name: str


class CollectionSetList(BaseModel):
    sets: list[CollectionSet]
    owner_revision: int


@router.get('/sets', response_model=CollectionSetList)
def collection_sets(location_id: UUID | None = None, user_id: str = Depends(verified_user)):
    """The sets of the cards in All owned or one Storage Leaf, once each, for the workspace Set filter.
    Search and filters don't narrow it, so every choice stays offered."""
    with connect() as conn, conn.transaction():
        conn.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
        owner = conn.execute('SELECT revision FROM inventory_owner WHERE user_id=%s', (user_id,)).fetchone()
        if location_id:
            leaf = conn.execute('SELECT kind FROM location WHERE owner_id=%s AND id=%s', (user_id, location_id)).fetchone()
            if not leaf:
                fail(404, 'LOCATION_NOT_FOUND')
            if leaf['kind'] not in ('storage_leaf', 'deck'):
                fail(409, 'NOT_STORAGE_LEAF')
        rows = conn.execute(f"""SELECT pd.set_id,min(pd.set_name) AS set_name FROM holding h
          JOIN catalog_edition e ON e.id=h.edition_id
          JOIN catalog_printing_display pd ON pd.printing_id=e.printing_id
          WHERE h.owner_id=%s{' AND h.location_id=%s' if location_id else ''} AND pd.set_id<>''
          GROUP BY pd.set_id ORDER BY lower(min(pd.set_name)),pd.set_id""",
                            [user_id, *([location_id] if location_id else [])]).fetchall()
        return CollectionSetList(sets=[CollectionSet(**row) for row in rows],
                                 owner_revision=owner['revision'] if owner else 1)


class CollectionRevision(BaseModel):
    owner_revision: int


@router.get('/revision', response_model=CollectionRevision)
def collection_revision(user_id: str = Depends(verified_user)):
    """The owner revision alone: one row, no lock. The workspace reads it when a tab regains focus to
    notice changes made elsewhere."""
    with connect() as conn:
        owner = conn.execute('SELECT revision FROM inventory_owner WHERE user_id=%s', (user_id,)).fetchone()
        return CollectionRevision(owner_revision=owner['revision'] if owner else 1)
