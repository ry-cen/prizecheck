"""Evidence-backed catalog decisions and explicit collector reassignment."""
from datetime import datetime
from typing import Literal
from uuid import UUID
import hashlib
import hmac
import json
from fastapi import APIRouter,Depends,HTTPException
from pydantic import BaseModel,Field,HttpUrl
from .main import connect,require_owner,verified_user
from .missing_cards import _code_hash
from .holdings import fail
from . import public_catalog

router=APIRouter()

class CatalogReviewView(BaseModel):
    id: UUID
    printing_id: UUID | None
    source_id: str
    kind: str
    status: str
    detail: str
    candidate: dict
    created_at: datetime
    evidence_digest: str
    # The Printing as the catalog records it now (null without a Printing), shown beside the incoming change.
    # Outside the evidence digest, which binds only to what the source sent.
    current_name: str | None=None
    current_set_id: str | None=None
    current_set_name: str | None=None
    current_collector_number: str | None=None

class EditionReplacementInput(BaseModel):
    edition_id: UUID
    replacement_edition_id: UUID

class CatalogDecision(BaseModel):
    # The decision binds to the exact evidence the reviewer was shown.
    evidence_digest: str=Field(pattern=r'^[0-9a-f]{64}$')
    decision: Literal['keep_existing','confirm_source','deprecate_edition','deprecate_printing']
    reason: str=Field(min_length=1,max_length=2000)
    evidence_url: HttpUrl
    code: str | None=Field(default=None,pattern=r'^\d{6}$')
    manual_printing_id: UUID | None=None
    edition_id: UUID | None=None
    replacement_edition_id: UUID | None=None
    replacement_printing_id: UUID | None=None
    edition_replacements: list[EditionReplacementInput]=Field(default_factory=list,max_length=500)


def evidence_digest(row):
    shown={key:row[key] for key in ('id','printing_id','source_id','kind','detail','candidate','source_fingerprint')}
    return hashlib.sha256(json.dumps(shown,sort_keys=True,default=str,ensure_ascii=False).encode()).hexdigest()

def release_price_slots(conn,edition_ids):
    """A deprecated Edition stops holding its product and price slot, so its replacement can be verified.

    Verified Editions become unmapped (``reviewed_unmapped``, sticky against imports and rule activations) and the
    change is stamped from the commit-ordered clock, which the caller's ``catalog_state`` lock already precedes.
    Returns whether any Edition changed, so the caller delivers the new public state after its commit.
    """
    conn.execute('SELECT catalog_begin_correction()')
    return conn.execute("""UPDATE catalog_edition_metadata SET mapping_state='unverified',mapping_reason='reviewed_unmapped',
      product_id=NULL,quote_variant=NULL,mapping_basis=NULL,mapping_decision_id=NULL,matching_activation_id=NULL,
      accepted_fingerprint=NULL,accepted_projection=NULL,auto_closed=true,mapping_revision=mapping_revision+1,updated_at=now()
      WHERE edition_id=ANY(%s) AND mapping_state='verified' RETURNING edition_id""",(list(edition_ids),)).fetchone() is not None

def view(row):return CatalogReviewView(**row,evidence_digest=evidence_digest(row))

def consume_review_code(conn,owner_id,review_id,action,code):
    if code is None: fail(422,'FRESH_CODE_REQUIRED')
    row=conn.execute('''SELECT * FROM catalog_approval_code WHERE owner_id=%s AND review_id=%s AND action=%s
      ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE''',(owner_id,review_id,action)).fetchone()
    if not row or row['consumed_at'] or row['attempts']>=3 or row['expires_at']<=datetime.now(row['expires_at'].tzinfo):
        fail(403,'INVALID_APPROVAL_CODE')
    if not hmac.compare_digest(row['code_hash'],_code_hash(owner_id,review_id,action,code)):
        conn.execute('UPDATE catalog_approval_code SET attempts=attempts+1 WHERE id=%s',(row['id'],))
        conn.commit();fail(403,'INVALID_APPROVAL_CODE')
    conn.execute('UPDATE catalog_approval_code SET consumed_at=now() WHERE id=%s',(row['id'],))

@router.get('/api/admin/catalog-reviews',response_model=list[CatalogReviewView])
def reviews(user_id: str=Depends(verified_user)):
    with connect() as conn:
        require_owner(conn,user_id)
        return [view(row) for row in conn.execute("""SELECT r.*,d.display_name AS current_name,d.set_id AS current_set_id,
          d.set_name AS current_set_name,d.collector_number AS current_collector_number
          FROM catalog_review r LEFT JOIN catalog_printing_display d ON d.printing_id=r.printing_id
          WHERE r.status='pending' ORDER BY r.created_at,r.id LIMIT 100""").fetchall()]

@router.post('/api/admin/catalog-reviews/{review_id}/decision',response_model=CatalogReviewView)
def decide(review_id: UUID,command: CatalogDecision,user_id: str=Depends(verified_user)):
    released=False
    with connect() as conn:
        require_owner(conn,user_id)
        state=conn.execute('SELECT active_generation,revision FROM catalog_state WHERE singleton FOR UPDATE').fetchone()
        row=conn.execute('SELECT * FROM catalog_review WHERE id=%s FOR UPDATE',(review_id,)).fetchone()
        if not row:fail(404,'REVIEW_NOT_FOUND')
        if row['status']!='pending':fail(409,'REVIEW_ALREADY_RESOLVED')
        if not command.reason.strip():fail(422,'REASON_REQUIRED')
        if not hmac.compare_digest(command.evidence_digest,evidence_digest(row)):fail(409,'REVIEW_EVIDENCE_CHANGED')
        status='retained'
        if command.decision=='confirm_source':
            if row['kind']!='source_match' or str(command.manual_printing_id) not in row['candidate'].get('manual_printing_ids',[]):
                fail(422,'INVALID_PHYSICAL_MATCH')
            if not conn.execute("SELECT 1 FROM catalog_printing WHERE id=%s AND source='manual'",(command.manual_printing_id,)).fetchone():
                fail(422,'INVALID_PHYSICAL_MATCH')
            linked=conn.execute('SELECT printing_id FROM catalog_source_reference WHERE source_id=%s',(row['source_id'],)).fetchone()
            if linked and linked['printing_id']!=command.manual_printing_id:fail(409,'SOURCE_ALREADY_LINKED')
            consume_review_code(conn,user_id,review_id,'confirm_source',command.code)
            conn.execute('''INSERT INTO catalog_source_reference(source_id,printing_id,review_id,evidence_url)
              VALUES (%s,%s,%s,%s) ON CONFLICT(source_id) DO NOTHING''',(row['source_id'],command.manual_printing_id,review_id,str(command.evidence_url)))
            status='confirmed'
        elif command.decision=='deprecate_printing':
            original=row['printing_id']
            if not original or not command.replacement_printing_id or original==command.replacement_printing_id:
                fail(422,'INVALID_REPLACEMENT')
            original_editions={r['id'] for r in conn.execute('SELECT id FROM catalog_edition WHERE printing_id=%s',(original,)).fetchall()}
            provided={item.edition_id for item in command.edition_replacements}
            if provided!=original_editions or len(provided)!=len(command.edition_replacements):
                fail(422,'INCOMPLETE_EDITION_MAPPING')
            targets={r['edition_id'] for r in conn.execute("""SELECT ge.edition_id FROM catalog_generation_edition ge
              JOIN catalog_generation_printing gp ON gp.generation_id=ge.generation_id AND gp.printing_id=ge.printing_id
              WHERE ge.generation_id=%s AND ge.printing_id=%s AND ge.active AND NOT gp.tombstoned""",
              (state['active_generation'],command.replacement_printing_id)).fetchall()}
            if not targets or any(item.replacement_edition_id not in targets for item in command.edition_replacements):
                fail(422,'INVALID_REPLACEMENT')
            if conn.execute('SELECT 1 FROM catalog_printing_replacement WHERE printing_id=%s',(original,)).fetchone() or conn.execute('SELECT 1 FROM catalog_edition_replacement WHERE edition_id=ANY(%s)',(list(original_editions),)).fetchone():
                fail(409,'EDITION_ALREADY_DEPRECATED')
            consume_review_code(conn,user_id,review_id,'resolve_catalog',command.code)
            conn.execute('INSERT INTO catalog_printing_replacement VALUES (%s,%s,%s)',(original,command.replacement_printing_id,review_id))
            for item in command.edition_replacements:
                conn.execute("""INSERT INTO catalog_edition_replacement(edition_id,replacement_edition_id,review_id,reviewer_id,evidence_url,reason)
                  VALUES (%s,%s,%s,%s,%s,%s)""",(item.edition_id,item.replacement_edition_id,review_id,user_id,str(command.evidence_url),command.reason.strip()))
            conn.execute('UPDATE catalog_generation_edition SET active=false WHERE generation_id=%s AND printing_id=%s',(state['active_generation'],original))
            released=release_price_slots(conn,original_editions)
            status='corrected'
        elif command.decision=='deprecate_edition':
            if not command.edition_id or not command.replacement_edition_id or command.edition_id==command.replacement_edition_id:
                fail(422,'INVALID_REPLACEMENT')
            source=conn.execute('SELECT printing_id FROM catalog_edition WHERE id=%s',(command.edition_id,)).fetchone()
            if not source or row['printing_id']!=source['printing_id']:fail(422,'INVALID_REPLACEMENT')
            target=conn.execute('''SELECT 1 FROM catalog_generation_edition ge
              JOIN catalog_generation_printing gp ON gp.generation_id=ge.generation_id AND gp.printing_id=ge.printing_id
              WHERE ge.generation_id=%s AND ge.edition_id=%s AND ge.active AND NOT gp.tombstoned''',
              (state['active_generation'],command.replacement_edition_id)).fetchone()
            if not target:fail(422,'INVALID_REPLACEMENT')
            if conn.execute('SELECT 1 FROM catalog_edition_replacement WHERE edition_id=%s',(command.edition_id,)).fetchone():
                fail(409,'EDITION_ALREADY_DEPRECATED')
            consume_review_code(conn,user_id,review_id,'resolve_catalog',command.code)
            conn.execute('''INSERT INTO catalog_edition_replacement(edition_id,replacement_edition_id,review_id,reviewer_id,evidence_url,reason)
              VALUES (%s,%s,%s,%s,%s,%s)''',(command.edition_id,command.replacement_edition_id,review_id,user_id,str(command.evidence_url),command.reason.strip()))
            conn.execute('UPDATE catalog_generation_edition SET active=false WHERE generation_id=%s AND edition_id=%s',(state['active_generation'],command.edition_id))
            released=release_price_slots(conn,[command.edition_id])
            status='corrected'
        else:
            consume_review_code(conn,user_id,review_id,'resolve_catalog',command.code)
        result=conn.execute('''UPDATE catalog_review SET status=%s,reviewer_id=%s,reviewed_at=now(),evidence_url=%s,reason=%s
          WHERE id=%s RETURNING *''',(status,user_id,str(command.evidence_url),command.reason.strip(),review_id)).fetchone()
        conn.execute('UPDATE catalog_state SET revision=revision+1 WHERE singleton')
        response=view(result)
    if released:public_catalog.publish_catalog_best_effort()  # after the commit; the outbox keeps it recoverable
    return response

class ReassignHolding(BaseModel):
    location_id: UUID
    edition_id: UUID
    replacement_edition_id: UUID
    quantity: str
    expected_version: int=Field(ge=1)
    idempotency_key: UUID

class ReassignResult(BaseModel):
    quantity: str
    owner_revision: int

class ReplacementView(BaseModel):
    edition_id: UUID
    replacement_edition_id: UUID
    evidence_url: str
    reason: str

@router.get('/api/catalog/edition-replacements',response_model=list[ReplacementView])
def replacements(user_id: str=Depends(verified_user)):
    with connect() as conn:
        return [ReplacementView(**row) for row in conn.execute('''SELECT er.* FROM catalog_edition_replacement er
          WHERE EXISTS (SELECT 1 FROM holding h WHERE h.owner_id=%s AND h.edition_id=er.edition_id)
          ORDER BY er.created_at,er.edition_id''',(user_id,)).fetchall()]

@router.post('/api/holdings/reassign',response_model=ReassignResult)
def reassign(command: ReassignHolding,user_id: str=Depends(verified_user)):
    import hashlib,json
    from .moves import leaf,quantity,MAX_QUANTITY,check_promises
    from .loan_inventory import follow_replacement,replacement_parties
    from .social.owners import lock_owners
    amount=quantity(command.quantity)
    payload=command.model_dump(mode='json',exclude={'idempotency_key'})
    digest=hashlib.sha256(json.dumps({'action':'reassign',**payload},sort_keys=True).encode()).hexdigest()
    with connect() as conn,conn.transaction():
        # Open Loans naming the Edition follow it (spec item 15): every owner they involve is locked in ascending
        # user_id FOR NO KEY UPDATE, as the Loan steps lock them (owners.lock_owners), the collector's own row too. It
        # still waits on the collector's own inventory commands, which take it FOR UPDATE, but not on the key share
        # another collector's Borrow Request or Lend Offer takes on it when it names the collector, while holding its
        # own owner row: FOR UPDATE here closed that cycle.
        parties=replacement_parties(conn,user_id,command.edition_id)
        conn.execute('INSERT INTO inventory_owner(user_id) VALUES (%s) ON CONFLICT DO NOTHING',(user_id,))
        lock_owners(conn,user_id,*parties)
        revision=conn.execute('SELECT revision FROM inventory_owner WHERE user_id=%s',(user_id,)).fetchone()['revision']
        conn.execute('DELETE FROM mutation_request WHERE owner_id=%s AND expires_at<=now()',(user_id,))
        prior=conn.execute('''SELECT mr.command_digest,mr.result_revision,r.copy_count FROM mutation_request mr
          LEFT JOIN move_response r ON r.owner_id=mr.owner_id AND r.request_key=mr.request_key
          WHERE mr.owner_id=%s AND mr.request_key=%s''',(user_id,command.idempotency_key)).fetchone()
        if prior:
            if prior['command_digest']!=digest:fail(409,'IDEMPOTENCY_KEY_REUSED')
            if prior['copy_count'] is None:fail(409,'REPLAY_OUTCOME_UNAVAILABLE')
            return ReassignResult(quantity=str(prior['copy_count']),owner_revision=prior['result_revision'])
        if not leaf(conn,user_id,command.location_id):fail(404,'LOCATION_NOT_FOUND')
        link=conn.execute('''SELECT 1 FROM catalog_edition_replacement
          WHERE edition_id=%s AND replacement_edition_id=%s''',(command.edition_id,command.replacement_edition_id)).fetchone()
        if not link:fail(422,'INVALID_REPLACEMENT')
        state=conn.execute('SELECT active_generation FROM catalog_state WHERE singleton FOR SHARE').fetchone()
        target=conn.execute('''SELECT 1 FROM catalog_generation_edition ge JOIN catalog_generation_printing gp
          ON gp.generation_id=ge.generation_id AND gp.printing_id=ge.printing_id
          WHERE ge.generation_id=%s AND ge.edition_id=%s AND ge.active AND NOT gp.tombstoned''',
          (state['active_generation'],command.replacement_edition_id)).fetchone()
        if not target:fail(422,'EDITION_UNAVAILABLE')
        source=conn.execute('SELECT quantity,version FROM holding WHERE owner_id=%s AND location_id=%s AND edition_id=%s',
          (user_id,command.location_id,command.edition_id)).fetchone()
        if not source or source['version']!=command.expected_version:fail(409,'STALE_HOLDING')
        if source['quantity']<amount:fail(409,'INSUFFICIENT_QUANTITY')
        current=conn.execute('SELECT quantity FROM holding WHERE owner_id=%s AND location_id=%s AND edition_id=%s',
          (user_id,command.location_id,command.replacement_edition_id)).fetchone()
        if current and current['quantity']>MAX_QUANTITY-amount:fail(409,'QUANTITY_OVERFLOW')
        # The collector's open Loans naming the Edition follow it to the replacement where they can (social network
        # spec item 15, loan_inventory.follow_replacement); then the old Edition loses the copies, refused when open
        # Loans still on it promise them (#252).
        follow_replacement(conn,user_id,command.edition_id,command.replacement_edition_id,amount,parties|{user_id})
        check_promises(conn,user_id,{command.edition_id:amount})
        new_revision=revision+1
        if source['quantity']==amount:
            conn.execute('DELETE FROM holding WHERE owner_id=%s AND location_id=%s AND edition_id=%s',
              (user_id,command.location_id,command.edition_id))
        else:
            conn.execute('UPDATE holding SET quantity=quantity-%s,version=%s WHERE owner_id=%s AND location_id=%s AND edition_id=%s',
              (amount,new_revision,user_id,command.location_id,command.edition_id))
        # In a Deck, migration 031's holding trigger covers the replacement copies; the old Edition's line stays.
        conn.execute('''INSERT INTO holding(owner_id,location_id,edition_id,quantity,version) VALUES (%s,%s,%s,%s,%s)
          ON CONFLICT(owner_id,location_id,edition_id) DO UPDATE SET quantity=holding.quantity+EXCLUDED.quantity,version=EXCLUDED.version''',
          (user_id,command.location_id,command.replacement_edition_id,amount,new_revision))
        conn.execute('UPDATE inventory_owner SET revision=%s WHERE user_id=%s',(new_revision,user_id))
        conn.execute('INSERT INTO mutation_request(owner_id,request_key,command_digest,result_revision) VALUES (%s,%s,%s,%s)',
          (user_id,command.idempotency_key,digest,new_revision))
        conn.execute('INSERT INTO move_response(owner_id,request_key,edition_count,copy_count) VALUES (%s,%s,1,%s)',
          (user_id,command.idempotency_key,amount))
        return ReassignResult(quantity=str(amount),owner_revision=new_revision)

class ReviewEditionView(BaseModel):
    id: UUID
    descriptor: dict
    # Copies of this Edition across every collection (the sum of its Holdings), so the owner sees what a
    # deprecation leaves for collectors to reassign. A count only: no collector, Location or user id.
    holdings: int

@router.get('/api/admin/catalog-reviews/{review_id}/editions',response_model=list[ReviewEditionView])
def review_editions(review_id: UUID,user_id: str=Depends(verified_user)):
    with connect() as conn:
        require_owner(conn,user_id)
        review=conn.execute('SELECT printing_id FROM catalog_review WHERE id=%s',(review_id,)).fetchone()
        if not review:fail(404,'REVIEW_NOT_FOUND')
        return [ReviewEditionView(**row) for row in conn.execute('''SELECT e.id,e.descriptor,coalesce(sum(h.quantity),0)::bigint AS holdings
          FROM catalog_edition e LEFT JOIN holding h ON h.edition_id=e.id WHERE e.printing_id=%s
          GROUP BY e.id ORDER BY e.descriptor_key,e.id''',(review['printing_id'],)).fetchall()]
