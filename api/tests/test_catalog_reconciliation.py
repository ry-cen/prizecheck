"""Safe refresh job and owner/collector HTTP contracts."""
import json
from uuid import uuid4
import pytest
from app.catalog import CatalogError, claim_run, execute_run
from app.main import connect
from test_catalog import Source, reset_catalog
from test_holdings import call


def run(source):
    with connect() as conn:
        run_id=conn.execute('INSERT INTO catalog_run DEFAULT VALUES RETURNING id').fetchone()['id']
        conn.commit()
        claimed=claim_run(conn,run_id)
        assert claimed==run_id
        execute_run(conn,run_id,source)
    return run_id


def test_descriptor_collision_and_fetched_id_mismatch_keep_searchable_generation():
    reset_catalog(); first=run(Source())
    class Collision(Source):
        def fetch(self,sid):
            result=super().fetch(sid)
            result['variants_detailed']=[{'finish':'holo','variantId':'a'},{'finish':'holo','variantId':'b'}]
            return result
    with pytest.raises(CatalogError,match='Descriptor collision on test-1'): run(Collision())
    with connect() as conn:
        assert conn.execute('SELECT active_generation FROM catalog_state').fetchone()['active_generation']==first
    class WrongIdentity(Source):
        def fetch(self,sid):
            result=super().fetch(sid);result['id']='different';return result
    with pytest.raises(CatalogError,match='source ID mismatch'):run(WrongIdentity())


def test_a_variant_listed_twice_imports_as_one_edition():
    # TCGdex lists some variants twice, entry for entry (gym2-75): the same physical variant, not a collision.
    reset_catalog()
    class Doubled(Source):
        def fetch(self,sid):
            result=super().fetch(sid)
            variant={'type':'holo','size':'standard','variantId':'h','thirdParty':{'tcgplayer':1},
                     'pricing':{'tcgplayer':{'holofoil':{'productId':1,'marketPrice':'2.50'}}}}
            result['variants_detailed']=[variant,json.loads(json.dumps(variant))]
            return result
    run(Doubled())
    with connect() as conn:
        rows=conn.execute("""SELECT e.descriptor,m.mapping_candidate->>'correspondence' AS correspondence
          FROM catalog_edition e JOIN catalog_printing p ON p.id=e.printing_id
          JOIN catalog_edition_metadata m ON m.edition_id=e.id WHERE p.source_id='test-2'""").fetchall()
    assert [(row['descriptor'],row['correspondence']) for row in rows]==[({'type':'holo','size':'standard','thirdParty':{'tcgplayer':1}},'source_candidate')]


def test_name_variant_drift_preserves_owned_display_and_safe_editions():
    reset_catalog(); run(Source())
    owner=f'collector-{uuid4()}'
    with connect() as conn:
        conn.execute('INSERT INTO inventory_owner(user_id) VALUES (%s)',(owner,))
        leaf=conn.execute("INSERT INTO location(id,owner_id,name,kind) VALUES (%s,%s,'Binder','storage_leaf') RETURNING id",(uuid4(),owner)).fetchone()['id']
        edition=conn.execute("SELECT e.id FROM catalog_edition e JOIN catalog_printing p ON p.id=e.printing_id WHERE p.source_id='test-2' AND e.descriptor->>'finish'='reverse'").fetchone()['id']
        conn.execute('INSERT INTO holding VALUES (%s,%s,%s,3,1)',(owner,leaf,edition))
    class Drift(Source):
        def fetch(self,sid):
            result=super().fetch(sid)
            if sid=='test-2':
                result['name']='Raichu';result['set']={'id':'changed','name':'Changed Set'};result['localId']='999'
                result['variants']={'normal':True,'firstEdition':True}
            return result
    run(Drift())
    row=call('GET',f'/api/holdings/{leaf}',owner).json()['holdings'][0]
    assert row['printing_name']=='Pikachu' and row['set_id']=='test' and row['collector_number']=='2'
    with connect() as conn:
        active=conn.execute('''SELECT ge.active FROM catalog_generation_edition ge
          JOIN catalog_state cs ON cs.active_generation=ge.generation_id WHERE ge.edition_id=%s''',(edition,)).fetchone()
        assert active and active['active']
        assert conn.execute("SELECT count(*) AS n FROM catalog_review WHERE kind IN ('name_change','variant_ambiguity')").fetchone()['n']==2


def seed_manual(set_id='future',number='1'):
    with connect() as conn:
        state=conn.execute('SELECT active_generation FROM catalog_state').fetchone()
        identity=conn.execute("INSERT INTO catalog_identity(identity_key,display_name) VALUES (%s,'Manual Pikachu') RETURNING id",(str(uuid4()),)).fetchone()['id']
        printing=conn.execute("INSERT INTO catalog_printing(source,identity_id) VALUES ('manual',%s) RETURNING id",(identity,)).fetchone()['id']
        edition=conn.execute("INSERT INTO catalog_edition(printing_id,descriptor_key,descriptor) VALUES (%s,'normal','{\"finish\":\"normal\"}') RETURNING id",(printing,)).fetchone()['id']
        conn.execute("""INSERT INTO catalog_generation_printing(generation_id,printing_id,source_id,set_id,set_name,collector_number,display_name,search_name,source_fingerprint,basic_energy)
          VALUES (%s,%s,%s,%s,'Future Set',%s,'Manual Pikachu','manual pikachu','manual','unresolved')""",(state['active_generation'],printing,'manual:'+str(printing),set_id,number))
        conn.execute('INSERT INTO catalog_generation_edition VALUES (%s,%s,%s,true)',(state['active_generation'],edition,printing))
    return printing,edition


def test_manual_survives_tombstones_and_source_match_enters_owner_queue():
    reset_catalog();run(Source(ids=[f'test-{n}' for n in range(1,101)]))
    manual,_=seed_manual()
    class Later(Source):
        def fetch(self,sid):
            card=super().fetch(sid)
            if sid.startswith('future-'):card['set']={'id':'future','name':'Future Set'}
            return card
    run(Later(ids=[f'test-{n}' for n in range(1,100)]+['future-1']))
    with connect() as conn:
        current=conn.execute('SELECT active_generation FROM catalog_state').fetchone()['active_generation']
        manual_row=conn.execute('SELECT tombstoned FROM catalog_generation_printing WHERE generation_id=%s AND printing_id=%s',(current,manual)).fetchone()
        assert manual_row and not manual_row['tombstoned']
        assert conn.execute("SELECT tombstoned FROM catalog_generation_printing WHERE generation_id=%s AND source_id='test-100'",(current,)).fetchone()['tombstoned']
        match=conn.execute("SELECT * FROM catalog_review WHERE kind='source_match'").fetchone()
        assert match and str(manual) in str(match['candidate'])
    with pytest.raises(CatalogError,match='source ID.*more than 1%'):
        run(Later(ids=[f'test-{n}' for n in range(1,98)]+['future-1','future-2','future-3']))


def shown(owner,review_id):
    """The evidence digest the owner's review queue displayed for one pending review."""
    queue=call('GET','/api/admin/catalog-reviews',owner)
    assert queue.status_code==200,queue.text
    return next(row['evidence_digest'] for row in queue.json() if row['id']==str(review_id))


def test_owner_confirmation_takes_effect_on_one_request_and_never_repoints_holdings():
    reset_catalog();run(Source())
    manual,manual_edition=seed_manual()
    class Match(Source):
        def fetch(self,sid):
            card=super().fetch(sid)
            if sid=='future-1':card['set']={'id':'future','name':'Future Set'}
            return card
    run(Match(ids=['test-1','test-2','future-1']))
    owner,other=str(uuid4()),str(uuid4())
    with connect() as conn:
        conn.execute('INSERT INTO inventory_owner(user_id) VALUES (%s),(%s)',(owner,other))
        conn.execute('INSERT INTO owner_binding(user_id) VALUES (%s)',(owner,))
    queue=call('GET','/api/admin/catalog-reviews',owner)
    assert queue.status_code==200,queue.text
    match=next(x for x in queue.json() if x['kind']=='source_match')
    path=f"/api/admin/catalog-reviews/{match['id']}/decision"
    body={'decision':'confirm_source','reason':'Same physical Printing confirmed','evidence_url':'https://example.org/photo','manual_printing_id':str(manual),'evidence_digest':match['evidence_digest']}
    assert call('POST',path,other,body).status_code==403
    result=call('POST',path,owner,{**body,'code':'123456'})  # a code from an older web bundle is ignored
    assert result.status_code==200,result.text
    assert result.json()['status']=='confirmed'
    with connect() as conn:
        assert conn.execute("SELECT printing_id FROM catalog_source_reference WHERE source_id='future-1'").fetchone()['printing_id']==manual
        assert conn.execute('SELECT count(*) AS n FROM holding').fetchone()['n']==0
    assert call('POST',path,owner,body).status_code==409


def test_deprecation_is_explicit_and_collector_reassignment_is_version_checked():
    reset_catalog();run(Source())
    owner,collector,other=str(uuid4()),str(uuid4()),str(uuid4())
    with connect() as conn:
        conn.execute('INSERT INTO inventory_owner(user_id) VALUES (%s),(%s),(%s)',(owner,collector,other))
        conn.execute('INSERT INTO owner_binding(user_id) VALUES (%s)',(owner,))
        source=conn.execute("SELECT e.id,p.id AS printing FROM catalog_edition e JOIN catalog_printing p ON p.id=e.printing_id WHERE p.source_id='test-2' AND e.descriptor->>'finish'='normal'").fetchone()
        target=conn.execute("SELECT e.id FROM catalog_edition e JOIN catalog_printing p ON p.id=e.printing_id WHERE p.source_id='test-2' AND e.descriptor->>'finish'='reverse'").fetchone()['id']
        leaf=conn.execute("INSERT INTO location(id,owner_id,name,kind) VALUES (%s,%s,'Binder','storage_leaf') RETURNING id",(uuid4(),collector)).fetchone()['id']
        conn.execute('INSERT INTO holding VALUES (%s,%s,%s,4,1)',(collector,leaf,source['id']))
        review=conn.execute("INSERT INTO catalog_review(printing_id,source_id,kind,source_fingerprint,detail) VALUES (%s,'test-2','variant_ambiguity','correction','Finish correction') RETURNING id",(source['printing'],)).fetchone()['id']
    decision=call('POST',f'/api/admin/catalog-reviews/{review}/decision',owner,{'decision':'deprecate_edition','reason':'Physical finish corrected','evidence_url':'https://example.org/foil','edition_id':str(source['id']),'replacement_edition_id':str(target),'evidence_digest':shown(owner,review)})
    assert decision.status_code==200,decision.text
    rows=call('GET',f'/api/holdings/{leaf}',collector).json()['holdings']
    assert rows[0]['edition_id']==str(source['id']) and rows[0]['quantity']=='4'
    body={'location_id':str(leaf),'edition_id':str(source['id']),'replacement_edition_id':str(target),'quantity':'2','expected_version':1,'idempotency_key':str(uuid4())}
    assert call('POST','/api/holdings/reassign',other,body).status_code==404
    first=call('POST','/api/holdings/reassign',collector,body)
    assert first.status_code==200,first.text
    assert call('POST','/api/holdings/reassign',collector,body).json()==first.json()
    stale=call('POST','/api/holdings/reassign',collector,{**body,'idempotency_key':str(uuid4())})
    assert stale.status_code==409 and stale.json()['detail']['code']=='STALE_HOLDING'
    rows=call('GET',f'/api/holdings/{leaf}',collector).json()['holdings']
    assert sorted(x['quantity'] for x in rows)==['2','2']


def test_printing_correction_requires_complete_explicit_edition_mapping():
    reset_catalog();run(Source())
    replacement,target=seed_manual()
    owner=str(uuid4())
    with connect() as conn:
        conn.execute('INSERT INTO inventory_owner(user_id) VALUES (%s)',(owner,))
        conn.execute('INSERT INTO owner_binding(user_id) VALUES (%s)',(owner,))
        original=conn.execute("SELECT id FROM catalog_printing WHERE source_id='test-2'").fetchone()['id']
        editions=conn.execute('SELECT id FROM catalog_edition WHERE printing_id=%s',(original,)).fetchall()
        review=conn.execute("INSERT INTO catalog_review(printing_id,source_id,kind,source_fingerprint,detail) VALUES (%s,'test-2','name_change','correction','Incorrect identity') RETURNING id",(original,)).fetchone()['id']
    body={'decision':'deprecate_printing','reason':'English physical identity corrected','evidence_url':'https://example.org/printing','replacement_printing_id':str(replacement),'evidence_digest':shown(owner,review),'edition_replacements':[{'edition_id':str(editions[0]['id']),'replacement_edition_id':str(target)}]}
    path=f'/api/admin/catalog-reviews/{review}/decision'
    rejected=call('POST',path,owner,body)
    assert rejected.status_code==422 and rejected.json()['detail']['code']=='INCOMPLETE_EDITION_MAPPING'
    body['edition_replacements']=[{'edition_id':str(e['id']),'replacement_edition_id':str(target)} for e in editions]
    accepted=call('POST',path,owner,body)
    assert accepted.status_code==200,accepted.text
    with connect() as conn:
        assert conn.execute('SELECT replacement_printing_id FROM catalog_printing_replacement WHERE printing_id=%s',(original,)).fetchone()['replacement_printing_id']==replacement
    run(Source())
    with connect() as conn:
        assert conn.execute('''SELECT count(*) AS n FROM catalog_generation_edition ge JOIN catalog_state cs ON cs.active_generation=ge.generation_id
          WHERE ge.printing_id=%s AND ge.active''',(original,)).fetchone()['n']==0


def test_keep_existing_resolves_on_one_owner_request_and_refuses_everyone_else():
    reset_catalog();run(Source())
    owner,other=str(uuid4()),str(uuid4())
    with connect() as conn:
        conn.execute('INSERT INTO inventory_owner(user_id) VALUES (%s),(%s)',(owner,other))
        conn.execute('INSERT INTO owner_binding(user_id) VALUES (%s)',(owner,))
        printing=conn.execute("SELECT id FROM catalog_printing WHERE source_id='test-2'").fetchone()['id']
        review=conn.execute("INSERT INTO catalog_review(printing_id,source_id,kind,source_fingerprint,detail) VALUES (%s,'test-2','name_change','keep-test','Name review') RETURNING id",(printing,)).fetchone()['id']
    body={'decision':'keep_existing','reason':'Retain physical card','evidence_url':'https://example.org/photo','evidence_digest':shown(owner,review)}
    path=f'/api/admin/catalog-reviews/{review}/decision'
    assert call('POST',path,other,body).status_code==403
    with connect() as conn:
        assert conn.execute('SELECT status FROM catalog_review WHERE id=%s',(review,)).fetchone()['status']=='pending'
    assert call('POST',path,owner,body).status_code==200
    with connect() as conn:
        assert conn.execute('SELECT status FROM catalog_review WHERE id=%s',(review,)).fetchone()['status']=='retained'


def test_reused_source_reference_is_frozen_in_search_and_queued_for_review():
    reset_catalog(); run(Source())
    owner=f'owner-{uuid4()}'
    with connect() as conn:
        conn.execute('INSERT INTO inventory_owner(user_id) VALUES (%s)',(owner,))
        conn.execute('INSERT INTO owner_binding(singleton,user_id) VALUES (true,%s)',(owner,))
    before=call('GET','/api/catalog/search?name=Pik',owner).json()['printings'][0]
    class ReusedReference(Source):
        def fetch(self,sid):
            record=super().fetch(sid)
            if sid=='test-2':
                record['set']={'id':'other','name':'Other Set'};record['localId']='999'
                record['variants']={'holo':True};record['image']='https://example.org/different'
            return record
    run(ReusedReference())
    after=call('GET','/api/catalog/search?name=Pik',owner).json()['printings'][0]
    assert after['set_id']=='test' and after['collector_number']=='2'
    assert after['id']==before['id'] and after['editions']==before['editions']
    reviews=call('GET','/api/admin/catalog-reviews',owner).json()
    reference=[review for review in reviews if review['kind']=='reference_change']
    assert len(reference)==1 and reference[0]['candidate']['set_id']=='other'
    assert reference[0]['candidate']['collector_number']=='999'


def test_decision_requires_the_unchanged_evidence_digest_shown_to_the_owner():
    reset_catalog();run(Source())
    owner=str(uuid4())
    with connect() as conn:
        conn.execute('INSERT INTO inventory_owner(user_id) VALUES (%s)',(owner,))
        conn.execute('INSERT INTO owner_binding(user_id) VALUES (%s)',(owner,))
        printing=conn.execute("SELECT id FROM catalog_printing WHERE source_id='test-2'").fetchone()['id']
        review=conn.execute("""INSERT INTO catalog_review(printing_id,source_id,kind,source_fingerprint,detail,candidate)
          VALUES (%s,'test-2','name_change','digest-test','Name review','{"name":"Raichu"}') RETURNING id""",(printing,)).fetchone()['id']
    viewed=shown(owner,review)
    with connect() as conn:
        conn.execute("""UPDATE catalog_review SET candidate='{"name":"Different evidence"}' WHERE id=%s""",(review,))
    path=f'/api/admin/catalog-reviews/{review}/decision'
    body={'decision':'keep_existing','reason':'Retain physical card','evidence_url':'https://example.org/photo'}
    assert call('POST',path,owner,body).status_code==422
    stale=call('POST',path,owner,{**body,'evidence_digest':viewed})
    assert stale.status_code==409 and stale.json()['detail']['code']=='REVIEW_EVIDENCE_CHANGED'
    with connect() as conn:
        assert conn.execute('SELECT status FROM catalog_review WHERE id=%s',(review,)).fetchone()['status']=='pending'
    current=shown(owner,review)
    assert current!=viewed
    accepted=call('POST',path,owner,{**body,'evidence_digest':current})
    assert accepted.status_code==200,accepted.text
    assert accepted.json()['candidate']=={'name':'Different evidence'}


def test_owner_review_shows_the_current_printing_and_copies_held_per_edition():
    # Owner controls' Catalog card (#168) shows the incoming change beside the Printing as recorded, and each
    # Edition's Holdings across every collection: a count only, and only for the owner.
    reset_catalog();run(Source())
    owner,first,second=str(uuid4()),str(uuid4()),str(uuid4())
    with connect() as conn:
        conn.execute('INSERT INTO inventory_owner(user_id) VALUES (%s),(%s),(%s)',(owner,first,second))
        conn.execute('INSERT INTO owner_binding(user_id) VALUES (%s)',(owner,))
        printing=conn.execute("SELECT id FROM catalog_printing WHERE source_id='test-2'").fetchone()['id']
        normal=conn.execute("SELECT id FROM catalog_edition WHERE printing_id=%s AND descriptor->>'finish'='normal'",(printing,)).fetchone()['id']
        for collector,quantity in ((first,3),(second,2)):
            leaf=conn.execute("INSERT INTO location(id,owner_id,name,kind) VALUES (%s,%s,'Binder','storage_leaf') RETURNING id",(uuid4(),collector)).fetchone()['id']
            conn.execute('INSERT INTO holding VALUES (%s,%s,%s,%s,1)',(collector,leaf,normal,quantity))
        review=conn.execute("""INSERT INTO catalog_review(printing_id,source_id,kind,source_fingerprint,detail,candidate)
          VALUES (%s,'test-2','name_change','holdings-test','Name review','{"name":"Raichu"}') RETURNING id""",(printing,)).fetchone()['id']
    row=next(r for r in call('GET','/api/admin/catalog-reviews',owner).json() if r['id']==str(review))
    assert (row['current_name'],row['current_set_id'],row['current_collector_number'])==('Pikachu','test','2')
    assert row['candidate']=={'name':'Raichu'}
    editions=call('GET',f'/api/admin/catalog-reviews/{review}/editions',owner)
    assert editions.status_code==200,editions.text
    held={edition['id']:edition['holdings'] for edition in editions.json()}
    assert held[str(normal)]==5 and len(held)>1
    assert all(count==0 for edition,count in held.items() if edition!=str(normal))
    assert all(set(edition)=={'id','descriptor','holdings'} for edition in editions.json())
    assert call('GET',f'/api/admin/catalog-reviews/{review}/editions',first).status_code==403
