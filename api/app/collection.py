"""Derived Collection totals; no mutable summary inventory."""
from uuid import UUID
from fastapi import APIRouter, Depends, Query, HTTPException
from typing import Literal
import base64, hashlib, hmac, json, os
from pydantic import BaseModel
from .main import connect, verified_user
from .holdings import HoldingView, fail

router = APIRouter(prefix='/api/collection', tags=['collection'])

class CollectionPage(BaseModel):
    entries: list[HoldingView]
    owner_revision: int
    catalog_revision: int
    next_cursor: str | None = None

class Distribution(BaseModel):
    holdings: list[HoldingView]

COLUMNS = """e.id AS edition_id,e.printing_id,ci.display_name AS printing_name,
 coalesce(gp.set_id,'') AS set_id,coalesce(gp.set_name,'') AS set_name,
 coalesce(gp.collector_number,'') AS collector_number,e.descriptor,gp.image_url"""
JOINS = """JOIN catalog_edition e ON e.id=h.edition_id
 JOIN catalog_printing p ON p.id=e.printing_id JOIN catalog_identity ci ON ci.id=p.identity_id
 LEFT JOIN catalog_generation_printing gp ON gp.printing_id=p.id AND gp.generation_id=%s"""

def views(rows):
    return [HoldingView(**{**row,'quantity':str(row['quantity']),
             'image_url':f"{row['image_url']}/low.webp" if row['image_url'] else None}) for row in rows]

def encode_cursor(context, key):
    data=json.dumps({'context':context,'key':key},separators=(',',':')).encode()
    signature=hmac.new(os.environ['INTERNAL_AUTH_SECRET'].encode(),data,hashlib.sha256).digest()
    return base64.urlsafe_b64encode(data+signature).decode().rstrip('=')


def decode_cursor(token,context):
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
        key=payload['key']
        if not isinstance(key,list) or len(key)!=2: raise ValueError
        UUID(key[1])
        return key
    except HTTPException: raise
    except (ValueError,KeyError,TypeError,UnicodeDecodeError): fail(400,'INVALID_CURSOR')


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
            filters+=" AND coalesce(gp.search_name,lower(ci.display_name)) LIKE %s ESCAPE '!'"
            params.append(name.replace('!','!!').replace('%','!%').replace('_','!_')+'%')
        if set_id: filters+=' AND lower(gp.set_id)=%s'; params.append(set_id)
        if collector_number: filters+=' AND lower(gp.collector_number)=%s'; params.append(collector_number)
        after=''
        order='search_name,edition_id' if sort=='name' else 'quantity DESC,edition_id'
        if key:
            if sort=='name': after='WHERE (search_name,edition_id)>(%s,%s)'; params.extend([key[0],UUID(key[1])])
            else:
                after='WHERE quantity<%s OR (quantity=%s AND edition_id>%s)'
                try: amount=int(key[0])
                except (ValueError,TypeError): fail(400,'INVALID_CURSOR')
                params.extend([amount,amount,UUID(key[1])])
        rows=conn.execute(f"""WITH totals AS (SELECT {COLUMNS},sum(h.quantity) AS quantity,1 AS version,
          coalesce(gp.search_name,lower(ci.display_name)) AS search_name,
          '00000000-0000-0000-0000-000000000000'::uuid AS location_id,'Collection' AS location_name
          FROM holding h {JOINS} WHERE h.owner_id=%s {scope} {filters}
          GROUP BY e.id,ci.id,gp.generation_id,gp.printing_id)
          SELECT * FROM totals {after} ORDER BY {order} LIMIT 31""",params).fetchall()
        page=rows[:30]
        next_cursor=encode_cursor(context,[str(page[-1]['quantity']) if sort=='quantity' else page[-1]['search_name'],str(page[-1]['edition_id'])]) if len(rows)>30 else None
        return CollectionPage(entries=views(page),owner_revision=revision,catalog_revision=state['revision'],next_cursor=next_cursor)

@router.get('/editions/{edition_id}',response_model=Distribution)
def distribution(edition_id: UUID,user_id: str=Depends(verified_user)):
    with connect() as conn:
        state=conn.execute('SELECT active_generation FROM catalog_state WHERE singleton').fetchone()
        rows=conn.execute(f"""SELECT {COLUMNS},h.quantity,h.version,h.location_id,l.name AS location_name
         FROM holding h JOIN location l ON l.id=h.location_id AND l.owner_id=h.owner_id {JOINS}
         WHERE h.owner_id=%s AND h.edition_id=%s ORDER BY l.name,l.id""",
         (state['active_generation'],user_id,edition_id)).fetchall()
        return Distribution(holdings=views(rows))
