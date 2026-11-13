"""Riftbound catalog parity against the real Pokémon migration history."""
import psycopg
import pytest

import schema_snapshot
import core_baseline_ownership as owners
from test_core_baseline import admin, databases, baseline, snapshot  # noqa: F401
from test_riftbound_migrate import fresh, migrate, ledger, ROOT  # noqa: F401
import migration_tracks
from migration_tracks import Track

TABLES = set('catalog_state catalog_run catalog_identity catalog_printing catalog_edition catalog_generation catalog_generation_printing catalog_generation_edition catalog_review catalog_printing_display catalog_attribute_state catalog_public_outbox catalog_set_code'.split())
VIEWS = set('catalog_printing_set_code catalog_printing_art catalog_edition_art'.split())
FUNCTIONS = set('catalog_search_words random_public_reference immutable_catalog_public_reference remember_printing_display immutable_printing_display'.split())
EXCLUDED = set('merged_into merge_decision_id catalog_identity_merged_into_fkey catalog_identity_merge_decision_id_fkey catalog_identity_merge_recorded catalog_identity_not_merged_into_itself default_printing_metadata default_edition_metadata stamp_format_facts_identity_change stamp_format_facts_identity catalog_printing_surviving_identity pokemon_promo_art_generation_changed'.split())
DEVIATIONS = {
 'constraint:catalog_printing.catalog_printing_source_check': "'tcgcsv'",
 'constraint:catalog_printing.catalog_printing_check': "'tcgcsv'",
 'constraint:catalog_printing.catalog_printing_tcgcsv_source_id_check': '^[1-9][0-9]{0,18}$',
 'column:catalog_generation_printing.basic_energy': "'not_applicable'",
 'constraint:catalog_generation_printing.catalog_generation_printing_basic_energy_check': "'not_applicable'",
 'constraint:catalog_review.catalog_review_kind_check': "'missing_from_source'",
 'view:catalog_printing_set_code': "''::text",
 'view:catalog_printing_art': 'NULL::text',
 'view:catalog_edition_art': 'false',
}
KINDS = 'identity_text_conflict card_scope_pending finish_policy_pending marker_grouping_pending duplicate_number_pending multi_value_delimiter_unrecognised price_without_product extended_field_repeated printing_details_differ missing_from_source group_change display_change duplicate_product_id'.split()

@pytest.fixture(scope='module')
def history(databases):
    url = databases()
    with psycopg.connect(url) as conn:
        migration_tracks.apply(conn, ROOT / 'migrations', (Track(),), lambda _: None)
    return url


def shared(snap):
    selected = {}
    for key, value in snap.items():
        kind, name = key.split(':', 1)
        relation = name.split('.')[0]
        if name.split('.')[-1] in EXCLUDED:
            continue
        if (relation in TABLES | VIEWS or
            kind == 'function' and name.split('(')[0] in FUNCTIONS or
            kind in ('index', 'sequence') and name.startswith('catalog_') and
                (kind == 'sequence' and name == 'catalog_public_outbox_sequence_seq' or any(f' ON {table} ' in value for table in TABLES))):
            selected[key] = value
    return selected


def test_entry_applies_core_then_the_riftbound_catalog_track(fresh):
    url, lines = fresh
    names = ['core/000_baseline.sql', 'core/001_zip_centroids.sql'] + [f'riftbound/{name}' for name in
        ('001_catalog.sql', '002_core_references.sql', '003_set_codes.sql', '004_writer_state.sql')]
    assert lines == [f'Applied {name}' for name in names]
    assert [row[0] for row in ledger(url)] == sorted(names)
    assert migrate(ROOT, url) == []


def test_every_shared_object_is_defined_as_the_pokemon_history_defines_it(history, fresh):
    expected, actual = shared(snapshot(history)[0]), shared(snapshot(fresh[0])[0])
    assert expected.keys() | DEVIATIONS.keys() == actual.keys() | DEVIATIONS.keys()
    assert {k: v for k, v in expected.items() if k not in DEVIATIONS} == {k: v for k, v in actual.items() if k not in DEVIATIONS}
    for key, fragment in DEVIATIONS.items():
        assert fragment in actual[key], key
    assert {k: v for k, v in expected.items() if k.startswith('column:') and k.split(':')[1].split('.')[0] in VIEWS} == {k: v for k, v in actual.items() if k.startswith('column:') and k.split(':')[1].split('.')[0] in VIEWS}
    assert {'table', 'column', 'constraint', 'index', 'view', 'function', 'trigger'} <= {k.split(':')[0] for k in expected}


def test_the_sixteen_core_references_are_restored_exactly(history, fresh):
    left, right = snapshot(history)[0], snapshot(fresh[0])[0]
    assert len(owners.OMITTED_FOREIGN_KEYS) == 16
    for table, name, _ in owners.OMITTED_FOREIGN_KEYS:
        key = f'constraint:{table}.{name}'
        assert left[key] == right[key]


def test_no_pokemon_or_auth_object_and_no_unlisted_catalog_relation(fresh, baseline):
    with psycopg.connect(fresh[0]) as conn, psycopg.connect(baseline) as core:
        assert set(schema_snapshot.relation_names(conn)) == set(schema_snapshot.relation_names(core)) | TABLES | VIEWS | {'riftbound_group_snapshot', 'riftbound_identity_evidence'}
    snap = snapshot(fresh[0])[0]
    assert not {k.split(':')[1].split('(')[0] for k in snap if k.startswith('function:')} & (owners.POKEMON_FUNCTIONS - FUNCTIONS)


def test_only_seed_rows_exist(fresh, baseline):
    with psycopg.connect(fresh[0]) as conn, psycopg.connect(baseline) as core:
        for table in schema_snapshot.relation_names(core):
            if table != 'schema_migration':
                assert schema_snapshot.rows_digest(conn, table) == schema_snapshot.rows_digest(core, table)
        counts = {table: schema_snapshot.rows_digest(conn, table)[0] for table in TABLES | {'riftbound_group_snapshot', 'riftbound_identity_evidence'}}
        assert {t: n for t, n in counts.items() if n} == {'catalog_state': 1, 'catalog_attribute_state': 1, 'catalog_set_code': 13}
        assert dict(conn.execute('SELECT set_id,code FROM catalog_set_code')) == dict(zip('24832 24901 24819 24698 24560 24519 24552 24344 24439 24528 24343 24502 24797'.split(), 'LGC GRFT RAD VEN UNL SFD JDG OGN OGS OPP PR RWB SGN'.split()))


@pytest.fixture
def conn(fresh):
    with psycopg.connect(fresh[0]) as c:
        yield c
        c.rollback()


@pytest.mark.parametrize('source,sid,constraint', [('tcgcsv','9000001',None), ('manual',None,None), ('tcgcsv',None,'catalog_printing_check'), ('manual','9000001','catalog_printing_check'), ('tcgdex',None,'catalog_printing_source_check')] + [('tcgcsv',s,'catalog_printing_tcgcsv_source_id_check') for s in ('0','01','-1','abc','1.0','1'*20,'')])
def test_source_rules(conn, source, sid, constraint):
    identity = conn.execute("INSERT INTO catalog_identity(identity_key,display_name) VALUES ('synthetic','Synthetic Unit') RETURNING id").fetchone()[0]
    def insert():
        conn.execute('INSERT INTO catalog_printing(source,source_id,identity_id) VALUES (%s,%s,%s)', (source,sid,identity))
    if constraint:
        with pytest.raises(psycopg.errors.CheckViolation) as error, conn.transaction():
            insert()
        assert error.value.diag.constraint_name == constraint
    else:
        insert()


def test_basic_energy_defaults_and_rejects_pokemon_values(conn):
    identity = conn.execute("INSERT INTO catalog_identity(identity_key,display_name) VALUES ('synthetic','Synthetic Unit') RETURNING id").fetchone()[0]
    printing = conn.execute("INSERT INTO catalog_printing(source,identity_id) VALUES ('manual',%s) RETURNING id", (identity,)).fetchone()[0]
    from uuid import uuid4
    gen = uuid4()
    conn.execute("INSERT INTO catalog_generation VALUES (%s,now(),1,''::bytea,'synthetic')", (gen,))
    query = "INSERT INTO catalog_generation_printing(generation_id,printing_id,source_id,set_id,set_name,collector_number,display_name,search_name,source_fingerprint) VALUES (%s,%s,'9000001','24344','Synthetic Set','1','Synthetic Unit','synthetic unit','synthetic') RETURNING basic_energy"
    assert conn.execute(query,(gen,printing)).fetchone()[0] == 'not_applicable'
    for value in ('supported','unresolved','not_basic',''):
        with pytest.raises(psycopg.errors.CheckViolation) as error, conn.transaction():
            conn.execute('UPDATE catalog_generation_printing SET basic_energy=%s', (value,))
        assert error.value.diag.constraint_name == 'catalog_generation_printing_basic_energy_check'


def test_review_kinds_are_the_thirteen(conn):
    for kind in KINDS:
        conn.execute("INSERT INTO catalog_review(source_id,kind,source_fingerprint,detail) VALUES ('9000001',%s,'synthetic','Synthetic review')", (kind,))
    with pytest.raises(psycopg.errors.CheckViolation) as error, conn.transaction():
        conn.execute("INSERT INTO catalog_review(source_id,kind,source_fingerprint,detail) VALUES ('9000001','name_change','synthetic','Synthetic review')")
    assert error.value.diag.constraint_name == 'catalog_review_kind_check'
