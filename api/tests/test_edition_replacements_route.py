"""GET /api/catalog/edition-replacements: the full response for a collector who holds a replaced Edition and for one who does not."""
from uuid import uuid4
from app.main import connect
from test_catalog import Source, reset_catalog
from test_catalog_reconciliation import run, shown
from test_holdings import call


def test_edition_replacements_answer_only_the_replaced_editions_a_collector_holds():
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
    for user in (owner,collector,other):
        empty=call('GET','/api/catalog/edition-replacements',user)
        assert empty.status_code==200 and empty.json()==[]
    decision=call('POST',f'/api/admin/catalog-reviews/{review}/decision',owner,{'decision':'deprecate_edition','reason':'Physical finish corrected','evidence_url':'https://example.org/foil','edition_id':str(source['id']),'replacement_edition_id':str(target),'evidence_digest':shown(owner,review)})
    assert decision.status_code==200,decision.text
    expected=[{'edition_id':str(source['id']),'replacement_edition_id':str(target),'evidence_url':'https://example.org/foil','reason':'Physical finish corrected'}]
    held=call('GET','/api/catalog/edition-replacements',collector)
    assert held.status_code==200 and held.json()==expected
    assert list(held.json()[0])==['edition_id','replacement_edition_id','evidence_url','reason']
    for user in (owner,other):  # the Owner holds nothing, so the Owner sees none either
        none=call('GET','/api/catalog/edition-replacements',user)
        assert none.status_code==200 and none.json()==[]
