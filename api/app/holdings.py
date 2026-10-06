"""Owner-scoped Add command and paged Storage Leaf read model."""
import base64
import hashlib
import hmac
import json
import os
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from .main import connect, verified_user

router = APIRouter(prefix="/api/holdings", tags=["holdings"])
MAX_QUANTITY = 2**63 - 1


class AddHolding(BaseModel):
    location_id: UUID
    edition_id: UUID
    quantity: str
    idempotency_key: UUID


class AddResult(BaseModel):
    location_id: UUID
    edition_id: UUID
    quantity: str
    version: int
    owner_revision: int


class HoldingView(BaseModel):
    edition_id: UUID
    quantity: str
    version: int
    printing_id: UUID
    printing_name: str
    set_id: str
    set_name: str
    collector_number: str
    descriptor: dict
    image_url: str | None
    location_id: UUID
    location_name: str


class LeafHoldings(BaseModel):
    holdings: list[HoldingView]
    owner_revision: int
    catalog_revision: int
    next_cursor: str | None


def fail(status: int, code: str):
    raise HTTPException(status, {"code": code})


def parse_quantity(raw: str) -> int:
    if not raw or not raw.isascii() or not raw.isdecimal() or len(raw) > 19:
        fail(422, "INVALID_QUANTITY")
    quantity = int(raw)
    if quantity < 1 or quantity > MAX_QUANTITY:
        fail(422, "INVALID_QUANTITY")
    return quantity


def digest(command: AddHolding) -> str:
    # A fingerprint only; the operational mutation record stores no item identifiers.
    payload = {"action": "add", "location_id": str(command.location_id),
               "edition_id": str(command.edition_id), "quantity": str(parse_quantity(command.quantity))}
    return hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


@router.post("", response_model=AddResult)
def add_holding(command: AddHolding, user_id: str = Depends(verified_user)):
    quantity = parse_quantity(command.quantity)
    request_digest = digest(command)
    with connect() as conn, conn.transaction():
        # The owner lock serializes all inventory commands for this collector.
        conn.execute("INSERT INTO inventory_owner(user_id) VALUES (%s) ON CONFLICT DO NOTHING", (user_id,))
        owner = conn.execute("SELECT revision FROM inventory_owner WHERE user_id=%s FOR UPDATE", (user_id,)).fetchone()
        conn.execute("DELETE FROM mutation_request WHERE owner_id=%s AND expires_at <= now()", (user_id,))
        previous = conn.execute("""SELECT mr.command_digest,mr.result_revision,rs.result_quantity,rs.result_version
          FROM mutation_request mr LEFT JOIN mutation_response rs
            ON rs.owner_id=mr.owner_id AND rs.request_key=mr.request_key
          WHERE mr.owner_id=%s AND mr.request_key=%s""",
                                (user_id, command.idempotency_key)).fetchone()
        if previous:
            if previous["command_digest"] != request_digest:
                fail(409, "IDEMPOTENCY_KEY_REUSED")
            if previous["result_quantity"] is None:
                fail(409, "REPLAY_OUTCOME_UNAVAILABLE")
            return AddResult(location_id=command.location_id, edition_id=command.edition_id,
                             quantity=str(previous["result_quantity"]), version=previous["result_version"],
                             owner_revision=previous["result_revision"])
        leaf = conn.execute("""SELECT 1 FROM location l WHERE l.id=%s AND l.owner_id=%s
          AND l.kind IN ('storage_leaf','deck')
          AND NOT EXISTS (SELECT 1 FROM location child WHERE child.parent_id=l.id)""",
                            (command.location_id, user_id)).fetchone()
        if not leaf:
            fail(404, "LOCATION_NOT_FOUND")
        # Hold the promoted generation stable until this Add commits.
        catalog = conn.execute("SELECT active_generation FROM catalog_state WHERE singleton FOR SHARE").fetchone()
        edition = conn.execute("""SELECT 1 FROM catalog_generation_edition ge
          JOIN catalog_generation_printing gp ON gp.generation_id=ge.generation_id AND gp.printing_id=ge.printing_id
          WHERE ge.generation_id=%s AND ge.edition_id=%s AND ge.active AND NOT gp.tombstoned""",
                               (catalog["active_generation"], command.edition_id)).fetchone()
        if not edition:
            fail(422, "EDITION_UNAVAILABLE")
        current = conn.execute("""SELECT quantity FROM holding
          WHERE owner_id=%s AND location_id=%s AND edition_id=%s""",
                               (user_id, command.location_id, command.edition_id)).fetchone()
        if current and current["quantity"] > MAX_QUANTITY - quantity:
            fail(422, "QUANTITY_OVERFLOW")
        revision = owner["revision"] + 1
        result = conn.execute("""INSERT INTO holding(owner_id,location_id,edition_id,quantity,version)
          VALUES (%s,%s,%s,%s,%s)
          ON CONFLICT (owner_id,location_id,edition_id) DO UPDATE
          SET quantity=holding.quantity+EXCLUDED.quantity, version=EXCLUDED.version
          RETURNING quantity,version""",
                              (user_id, command.location_id, command.edition_id, quantity, revision)).fetchone()
        conn.execute("UPDATE inventory_owner SET revision=%s WHERE user_id=%s", (revision, user_id))
        conn.execute("""INSERT INTO mutation_request
          (owner_id,request_key,command_digest,result_revision)
          VALUES (%s,%s,%s,%s)""",
                     (user_id, command.idempotency_key, request_digest, revision))
        conn.execute("""INSERT INTO mutation_response(owner_id,request_key,result_quantity,result_version)
          VALUES (%s,%s,%s,%s)""",
                     (user_id, command.idempotency_key, result["quantity"], result["version"]))
        return AddResult(location_id=command.location_id, edition_id=command.edition_id,
                         quantity=str(result["quantity"]), version=result["version"], owner_revision=revision)


def cursor_encode(user_id: str, location_id: UUID, owner_revision: int, catalog_revision: int, row: dict) -> str:
    data = json.dumps({"v": 1, "u": user_id, "l": str(location_id), "r": owner_revision,
                       "c": catalog_revision, "k": [row["search_name"], str(row["edition_id"])]},
                      separators=(",", ":")).encode()
    signature = hmac.new(os.environ["INTERNAL_AUTH_SECRET"].encode(), data, hashlib.sha256).digest()
    return base64.urlsafe_b64encode(data + signature).decode().rstrip("=")


def cursor_decode(token: str, user_id: str, location_id: UUID, owner_revision: int, catalog_revision: int):
    try:
        raw = base64.urlsafe_b64decode(token + "=" * (-len(token) % 4))
        data, signature = raw[:-32], raw[-32:]
        if not hmac.compare_digest(signature, hmac.new(os.environ["INTERNAL_AUTH_SECRET"].encode(), data, hashlib.sha256).digest()):
            raise ValueError
        payload = json.loads(data)
        if payload["v"] != 1 or payload["u"] != user_id or payload["l"] != str(location_id):
            raise ValueError
        if payload["r"] != owner_revision:
            fail(409, "INVENTORY_CHANGED")
        if payload["c"] != catalog_revision:
            fail(409, "CATALOG_CHANGED")
        key = payload["k"]
        if not isinstance(key, list) or len(key) != 2 or not isinstance(key[0], str):
            raise ValueError
        return key[0], UUID(key[1])
    except HTTPException:
        raise
    except (ValueError, KeyError, TypeError, UnicodeDecodeError, json.JSONDecodeError):
        fail(400, "INVALID_CURSOR")


@router.get("/{location_id}", response_model=LeafHoldings)
def leaf_holdings(location_id: UUID, cursor: str | None = Query(default=None, max_length=1024),
                  name: str=Query(default='',max_length=120),set_id: str=Query(default='',max_length=80),
                  collector_number: str=Query(default='',max_length=40),sort: Literal['name','quantity']='name',
                  user_id: str = Depends(verified_user)):
    from .collection import decode_cursor, encode_cursor
    with connect() as conn, conn.transaction():
        conn.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
        owner = conn.execute("SELECT revision FROM inventory_owner WHERE user_id=%s", (user_id,)).fetchone()
        leaf = conn.execute("""SELECT id,name,kind FROM location WHERE id=%s AND owner_id=%s""",
                            (location_id, user_id)).fetchone()
        if not leaf:
            fail(404, "LOCATION_NOT_FOUND")
        if leaf["kind"] not in ("storage_leaf", "deck"):
            fail(409, "NOT_STORAGE_LEAF")
        state = conn.execute("SELECT active_generation,revision FROM catalog_state WHERE singleton").fetchone()
        revision = owner["revision"] if owner else 1
        name=name.strip().lower(); set_id=set_id.strip().lower(); collector_number=collector_number.strip().lower()
        context=[user_id,str(location_id),name,set_id,collector_number,sort,revision,state['revision']]
        key=decode_cursor(cursor,context) if cursor else None
        params=[state['active_generation'],user_id,location_id]
        filters=''
        if name:
            filters+=" AND coalesce(gp.search_name,lower(ci.display_name)) LIKE %s ESCAPE '!'"
            params.append(name.replace('!','!!').replace('%','!%').replace('_','!_')+'%')
        if set_id: filters+=' AND lower(gp.set_id)=%s'; params.append(set_id)
        if collector_number: filters+=' AND lower(gp.collector_number)=%s'; params.append(collector_number)
        after=''; order='coalesce(gp.search_name,lower(ci.display_name)),h.edition_id' if sort=='name' else 'h.quantity DESC,h.edition_id'
        if key:
            if sort=='name':
                after='AND (coalesce(gp.search_name,lower(ci.display_name)),h.edition_id)>(%s,%s)'
                params.extend([key[0],UUID(key[1])])
            else:
                after='AND (h.quantity<%s OR (h.quantity=%s AND h.edition_id>%s))'
                try: amount=int(key[0])
                except (ValueError,TypeError): fail(400,'INVALID_CURSOR')
                params.extend([amount,amount,UUID(key[1])])
        rows = conn.execute(f"""SELECT h.edition_id,h.quantity,h.version,h.location_id,l.name AS location_name,
          p.id AS printing_id,coalesce(pd.display_name,ci.display_name) AS printing_name,
          coalesce(gp.search_name,lower(ci.display_name)) AS search_name,
          coalesce(pd.set_id,'') AS set_id,coalesce(pd.set_name,'') AS set_name,
          coalesce(pd.collector_number,'') AS collector_number,e.descriptor,pd.image_url
          FROM holding h JOIN location l ON l.id=h.location_id AND l.owner_id=h.owner_id
          JOIN catalog_edition e ON e.id=h.edition_id
          JOIN catalog_printing p ON p.id=e.printing_id
          JOIN catalog_identity ci ON ci.id=p.identity_id
          LEFT JOIN catalog_printing_display pd ON pd.printing_id=p.id
          LEFT JOIN catalog_generation_printing gp ON gp.generation_id=%s AND gp.printing_id=p.id
          WHERE h.owner_id=%s AND h.location_id=%s {filters} {after}
          ORDER BY {order} LIMIT 49""", params).fetchall()
        page = rows[:48]
        views = [HoldingView(edition_id=row["edition_id"], quantity=str(row["quantity"]), version=row["version"],
                             printing_id=row["printing_id"], printing_name=row["printing_name"],
                             set_id=row["set_id"], set_name=row["set_name"], collector_number=row["collector_number"],
                             descriptor=row["descriptor"], image_url=f'{row["image_url"]}/low.webp' if row["image_url"] else None,
                             location_id=row["location_id"], location_name=row["location_name"]) for row in page]
        return LeafHoldings(holdings=views, owner_revision=revision, catalog_revision=state["revision"],
                            next_cursor=encode_cursor(context,[str(page[-1]['quantity']) if sort=='quantity' else page[-1]['search_name'],str(page[-1]['edition_id'])]) if len(rows)>48 else None)
