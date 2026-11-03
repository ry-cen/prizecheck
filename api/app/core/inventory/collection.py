"""Game-free Collection reads, keyset paging, totals and revision snapshots.

The game supplies facet columns, joins, predicates and cursor context at each listing call.
Catalog relation shapes follow docs/planning/shared-core/catalog-data-contract.md.
"""
from typing import Literal
from uuid import UUID

from pydantic import BaseModel

from app.api_errors import api_error as fail
from app.core.art.urls import route_address
from app.db import connect
from app.holdings import HoldingView
from app.location_tree import LOCATION_PATHS
from app.social import counts
from .cursors import anchor_columns, anchor_json, anchor_value, cursor_key, decode_cursor, encode_cursor


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
 coalesce(pd.set_id,'') AS set_id,psc.set_code AS set_code,coalesce(pd.set_name,'') AS set_name,
 coalesce(pd.collector_number,'') AS collector_number,e.descriptor,art.low_image_url AS art_source,art.stored_upgrade_url AS art_upgrade"""
JOINS = """JOIN catalog_edition e ON e.id=h.edition_id
 JOIN catalog_printing p ON p.id=e.printing_id JOIN catalog_identity ci ON ci.id=p.identity_id
 JOIN catalog_printing_set_code psc ON psc.printing_id=p.id
 LEFT JOIN catalog_printing_display pd ON pd.printing_id=p.id
 LEFT JOIN catalog_printing_art art ON art.printing_id=p.id
 LEFT JOIN catalog_generation_printing gp ON gp.printing_id=p.id AND gp.generation_id=%s"""


def views(rows, model=HoldingView):
    """The page's rows as views. Rows carry the art source, not the address: the route address (ADR 0020) is built here,
    for the page only, so a large Collection does not hash a version for every catalog row."""
    return [model(**{**{key:value for key,value in row.items() if key not in ('art_source','art_upgrade')},'quantity':str(row['quantity']),
             'image_url':route_address(row['printing_id'],row['art_source'],upgrade=row['art_upgrade'])}) for row in rows]


def collection(name, set_id, collector_number, sort, location_id, cursor, user_id):
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
          GROUP BY e.id,ci.id,pd.printing_id,gp.generation_id,gp.printing_id,art.low_image_url,art.stored_upgrade_url,psc.set_code)
          SELECT * FROM totals {after} ORDER BY {order} LIMIT 31""",params).fetchall()
        page=rows[:30]
        next_cursor=encode_cursor(context,[str(page[-1]['quantity']) if sort=='quantity' else page[-1]['search_name'],str(page[-1]['edition_id'])]) if len(rows)>30 else None
        return CollectionPage(entries=views(page,CollectionEntry),owner_revision=revision,catalog_revision=state['revision'],next_cursor=next_cursor)


def distribution(edition_id, user_id):
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
# Full Location paths such as "Shelf / Binder 2" (``location_tree.LOCATION_PATHS``).
HOLDING_PATHS = LOCATION_PATHS
# Every sort key is NOT NULL: a NULL would drop rows from the keyset comparison.
# edition_total is the Card Edition's copies within the listed rows (the view after search and filters).


def holding_columns(*, facet_columns):
    """Listing display and sort columns, extended by the game's facet expressions."""
    return f"""h.edition_id,h.location_id,l.name AS location_name,coalesce(lp.path,l.name) AS location_path,h.quantity,h.version,
      p.id AS printing_id,coalesce(pd.display_name,ci.display_name) AS printing_name,
      coalesce(pd.set_id,'') AS set_id,psc.set_code AS set_code,coalesce(pd.set_name,'') AS set_name,
      coalesce(pd.collector_number,'') AS collector_number,e.descriptor,art.low_image_url AS art_source,art.stored_upgrade_url AS art_upgrade,
      {facet_columns},
      coalesce(lower(pd.display_name),lower(ci.display_name)) AS search_name,
      lower(coalesce(lp.path,l.name)) AS location_key,
      lower(coalesce(pd.set_name,'')) AS set_key,
      substring(coalesce(pd.collector_number,'') from '^[0-9]+') IS NULL AS number_missing,
      coalesce(substring(pd.collector_number from '^[0-9]+')::numeric,0) AS number_value,
      lower(coalesce(pd.collector_number,'')) AS number_key,
      sum(h.quantity) OVER (PARTITION BY h.edition_id) AS edition_total"""


def card_joins(*, facet_joins):
    """Retained display/art/set-code joins plus the game's facet relation."""
    return f"""  JOIN catalog_edition e ON e.id=h.edition_id
      JOIN catalog_printing p ON p.id=e.printing_id
      JOIN catalog_identity ci ON ci.id=p.identity_id
      JOIN catalog_printing_set_code psc ON psc.printing_id=p.id
      LEFT JOIN catalog_printing_display pd ON pd.printing_id=p.id
      LEFT JOIN catalog_printing_art art ON art.printing_id=p.id
    {facet_joins}"""


def holding_from(*, facet_joins):
    return f"""FROM holding h JOIN location l ON l.id=h.location_id AND l.owner_id=h.owner_id
  LEFT JOIN paths lp ON lp.id=h.location_id
{card_joins(facet_joins=facet_joins)}
  WHERE h.owner_id=%s"""


HoldingSort = Literal['name-asc', 'name-desc', 'set-asc', 'set-desc', 'quantity-asc', 'quantity-desc']
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


def listing_conditions(name, set_id):
    conditions, condition_params = "", []
    if name:
        conditions += " AND coalesce(lower(pd.display_name),lower(ci.display_name)) LIKE %s ESCAPE '!'"
        condition_params.append('%' + name.replace('!', '!!').replace('%', '!%').replace('_', '!_') + '%')
    if set_id:
        conditions += ' AND pd.set_id=%s'; condition_params.append(set_id)
    return conditions, condition_params


def listing_snapshot(owner_revision, catalog_revision, attribute_revision):
    return f"{owner_revision}.{catalog_revision}.{attribute_revision}"


class CollectionTotals(BaseModel):
    holdings: int
    editions: int
    copies: str


def collection_holdings(location_id, sort, name, set_id, cursor, user_id, *,
                        facet_columns, facet_joins, facet_conditions, facet_params, facet_context):
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
                   name, set_id, *facet_context, revision,
                   [state['revision'], attributes['revision']]]
        conditions, condition_params = '', []
        if location_id:
            conditions += ' AND h.location_id=%s'; condition_params.append(location_id)
        filtered, values = listing_conditions(name, set_id)
        conditions += filtered + facet_conditions
        condition_params.extend([*values, *facet_params])
        base = [user_id, user_id, user_id, *condition_params]
        # Filters apply inside, so edition_total counts only the listed rows; anchors and pages filter outside.
        source = holding_from(facet_joins=facet_joins)
        listed = f'SELECT {holding_columns(facet_columns=facet_columns)} {source}{conditions}'
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
              {source}{conditions}""", base).fetchone()
            whole = location_id is None and not (name or set_id or any(facet_context))
            lent = str(sum(counts.lent_counts(conn, user_id, None).values()) if whole else 0)
            totals = CollectionTotals(holdings=counted['holdings'], editions=counted['editions'],
                                      copies=str(counted['copies']))
        next_cursor = (encode_cursor(context, [anchor_json(page[-1][column]) for column in anchor_columns(keys)])
                       if len(rows) > HOLDING_PAGE_SIZE else None)
        return dict(snapshot=listing_snapshot(revision, state['revision'], attributes['revision']), holdings=page,
                    owner_revision=revision, catalog_revision=state['revision'], next_cursor=next_cursor, totals=totals,
                    lent=None if totals is None else lent)


class CollectionSet(BaseModel):
    set_id: str
    set_name: str


class CollectionSetList(BaseModel):
    sets: list[CollectionSet]
    owner_revision: int


def collection_sets(location_id, user_id):
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
        rows = conn.execute(f"""SELECT pd.set_id,min(pd.set_name) AS set_name FROM (SELECT location_id,edition_id FROM holding WHERE owner_id=%s
            UNION SELECT location_id,edition_id FROM borrowed_holding WHERE borrower_id=%s) h
          JOIN catalog_edition e ON e.id=h.edition_id
          JOIN catalog_printing_display pd ON pd.printing_id=e.printing_id
          WHERE true{' AND h.location_id=%s' if location_id else ''} AND pd.set_id<>''
          GROUP BY pd.set_id ORDER BY lower(min(pd.set_name)),pd.set_id""",
                            [user_id, user_id, *([location_id] if location_id else [])]).fetchall()
        return CollectionSetList(sets=[CollectionSet(**row) for row in rows],
                                 owner_revision=owner['revision'] if owner else 1)


class CollectionRevision(BaseModel):
    owner_revision: int


def collection_revision(user_id):
    """The owner revision alone: one row, no lock. The workspace reads it when a tab regains focus to
    notice changes made elsewhere."""
    with connect() as conn:
        owner = conn.execute('SELECT revision FROM inventory_owner WHERE user_id=%s', (user_id,)).fetchone()
        return CollectionRevision(owner_revision=owner['revision'] if owner else 1)
