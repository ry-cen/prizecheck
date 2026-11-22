"""Synthetic Riftbound Catalog rows for the local Catalog proof; shared by the read-API tests and the connected browser spec.

The seed writes the accepted generation straight into catalog_state.active_generation. It proves reading an accepted
snapshot, not the ingestion acceptance workflow. As a command it acts only on a loopback database named tcg_rb_*.
"""
import argparse
import json
import os
from urllib.parse import urlparse
from uuid import uuid4

import psycopg

LOOPBACK = ('127.0.0.1', 'localhost', '::1')

FINISHES = {'normal': {'finish': 'normal'}, 'foil': {'finish': 'foil'},
            'unspecified': {'kind': 'unspecified', 'label': 'Unspecified Variant'}}



def wipe(url):
    with psycopg.connect(url) as conn:
        conn.execute('''TRUNCATE catalog_generation_edition, catalog_generation_printing, catalog_generation,
            catalog_edition, catalog_printing_display, catalog_printing, catalog_identity, catalog_review CASCADE''')
        # CASCADE also empties catalog_state through its generation reference; put the singleton row back.
        conn.execute('INSERT INTO catalog_state(singleton,active_generation) VALUES (true,NULL) ON CONFLICT DO NOTHING')
        conn.execute('UPDATE catalog_state SET active_generation=NULL,revision=0 WHERE singleton')


def seed(url, cards, *, activate=True):
    """Insert one generation of cards [(name, number, set_id, set_name, finishes, flags)]; return (generation, {key: ids})."""
    gen, made = uuid4(), {}
    with psycopg.connect(url) as conn:
        conn.execute('INSERT INTO catalog_generation(id,source_count,raw_gzip,raw_sha256) VALUES (%s,1,%s,%s)',
                     (gen, b'synthetic', 'synthetic'))
        for card in cards:
            name, number, set_id, set_name, finishes, flags = (*card, {})[:6] if len(card) == 5 else card
            identity = conn.execute('INSERT INTO catalog_identity(identity_key,display_name) VALUES (%s,%s) RETURNING id',
                                    (str(uuid4()), name)).fetchone()[0]
            source_id = str(9000001 + uuid4().int % 1000000000)
            printing = conn.execute("INSERT INTO catalog_printing(source,source_id,identity_id) VALUES ('tcgcsv',%s,%s) RETURNING id",
                                    (source_id, identity)).fetchone()[0]
            conn.execute('''INSERT INTO catalog_generation_printing(generation_id,printing_id,source_id,set_id,set_name,
                collector_number,display_name,search_name,source_fingerprint,basic_energy,tombstoned)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,'synthetic','not_applicable',%s)''',
                         (gen, printing, source_id, set_id, set_name, number, name, name.lower(), flags.get('tombstoned', False)))
            ids = []
            for finish in finishes:
                descriptor = FINISHES[finish]
                edition = conn.execute('''INSERT INTO catalog_edition(printing_id,descriptor_key,descriptor)
                    VALUES (%s,%s,%s) RETURNING id''', (printing, json.dumps(descriptor, sort_keys=True), json.dumps(descriptor))).fetchone()[0]
                conn.execute('INSERT INTO catalog_generation_edition(generation_id,edition_id,printing_id,active) VALUES (%s,%s,%s,%s)',
                             (gen, edition, printing, flags.get('active', True)))
                ids.append(str(edition))
            made[(name, number)] = {'printing': str(printing), 'editions': ids}
        if activate:
            conn.execute('UPDATE catalog_state SET active_generation=%s,revision=revision+1 WHERE singleton', (gen,))
    return gen, made


POPULATED = [
    ('Synthetic Dragon', '001/100', 'syn01', 'Synthetic Set 900', ('normal', 'foil')),
    ('Synthetic Knight', '002/100', 'syn01', 'Synthetic Set 900', ('unspecified',)),
    ('Alpha Sprite', 'P-7', '24344', 'Origins Synthetic', ('normal',)),
    *[(f'Synthetic Unit {n:02d}', f'{n + 2:03d}/100', 'syn01', 'Synthetic Set 900', ('normal',)) for n in range(1, 26)],
]
SCENARIOS = ('empty', 'unaccepted', 'populated')


def scenario(url: str, name: str) -> dict:
    """Reset the database to one named state; return {'editions': {'<name>|<number>': [edition ids]}}."""
    if name not in SCENARIOS:
        raise ValueError(f'unknown scenario {name!r}')
    wipe(url)
    if name == 'empty':
        return {'editions': {}}
    _, made = seed(url, POPULATED, activate=name == 'populated')
    return {'editions': {f'{card}|{number}': made[(card, number)]['editions'] for card, number in made}}


def checked_url(expected: str, environ=os.environ, connect=psycopg.connect, prefix: str = 'tcg_rb_') -> str:
    """The database URL, once the database it really reaches is the exact one the stack created.

    A URL can retarget itself through its query (host, hostaddr, dbname...), so no query parameter is accepted. The
    connection is then asked which database it is on, and that must be `expected`. The server's own address is not
    checked: a loopback-published container (the CI service) reports its bridge address, not 127.0.0.1. The target is
    pinned by the URL's loopback host instead, and by refusing the libpq variables that would redirect it."""
    if not expected.startswith(prefix):
        raise SystemExit('refusing: the expected database is not a tcg_rb_* name')
    if any(environ.get(key) for key in ('PGHOSTADDR', 'PGSERVICE', 'PGSERVICEFILE')):
        raise SystemExit('refusing: the environment redirects the PostgreSQL connection')
    url = environ['RIFTBOUND_DATABASE_URL']
    parsed = urlparse(url)
    if parsed.scheme not in ('postgresql', 'postgres') or parsed.query or parsed.params:
        raise SystemExit('refusing: the database URL must be a plain PostgreSQL URL with no parameters')
    if parsed.hostname not in LOOPBACK or parsed.path.lstrip('/') != expected:
        raise SystemExit('refusing: the database URL does not name the expected loopback database')
    with connect(url) as conn:
        (name,) = conn.execute('SELECT current_database()').fetchone()
    if name != expected:
        raise SystemExit('refusing: the connection does not reach the expected database')
    return url


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('name', choices=SCENARIOS)
    parser.add_argument('--database', required=True, help='the exact database the stack created')
    args = parser.parse_args()
    print(json.dumps(scenario(checked_url(args.database), args.name)))
