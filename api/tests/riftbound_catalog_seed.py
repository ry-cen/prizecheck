"""Synthetic Riftbound Catalog rows for the local Catalog proof; shared by the read-API tests and the connected browser spec.

The seed writes the accepted generation straight into catalog_state.active_generation. It proves reading an accepted
snapshot, not the ingestion acceptance workflow. As a command it acts only on a loopback database named tcg_rb_*.
"""
import argparse
import errno
import ipaddress
import json
import os
import socket
from uuid import uuid4

import psycopg
from psycopg.conninfo import conninfo_to_dict, make_conninfo

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


def loopback_addresses(host: str, getaddrinfo=socket.getaddrinfo) -> list[str]:
    """Every numeric address `host` resolves to, resolved once, IPv4 before IPv6; SystemExit unless all are loopback.

    A name is looked up again by each connection, so the checked connection and the writes could reach different
    servers. The caller pins one of the returned addresses as `hostaddr`."""
    try:
        found = {str(ipaddress.ip_address(host))}
    except ValueError:
        try:
            found = {str(ipaddress.ip_address(info[4][0].split('%')[0]))
                     for info in getaddrinfo(host, None, type=socket.SOCK_STREAM)}
        except (OSError, ValueError):
            raise SystemExit('refusing: the database host does not resolve to a loopback address') from None
    if not found or not all(ipaddress.ip_address(address).is_loopback for address in found):
        raise SystemExit('refusing: the database host does not resolve to a loopback address')
    return sorted(found, key=lambda address: (ipaddress.ip_address(address).version, ipaddress.ip_address(address)))


def probe_address(address: str, port: int, timeout: float = 2.0) -> None:
    """Open and close one TCP connection to (address, port); raises OSError when it cannot be made."""
    family = socket.AF_INET6 if ':' in address else socket.AF_INET
    with socket.socket(family, socket.SOCK_STREAM) as sock:
        sock.settimeout(timeout)
        sock.connect((address, port))


def libpq_port(params: dict, environ) -> str:
    """The port libpq will use: the URL's, else PGPORT, else its compiled default; SystemExit unless one number."""
    port = params.get('port') or environ.get('PGPORT') or next(
        (option.compiled.decode() for option in psycopg.pq.Conninfo.get_defaults() if option.keyword == b'port'), '5432')
    if not (port.isascii() and port.isdigit() and 0 < int(port) < 65536):
        raise SystemExit('refusing: the database URL does not name exactly one port')
    return port


def choose_address(addresses: list[str], port: int, probe=probe_address) -> str:
    """The address to check. One candidate is used as is. With several, a candidate is skipped only when its probe is
    refused (ECONNREFUSED); the first one that accepts is chosen, and any other outcome stops."""
    if len(addresses) == 1:
        return addresses[0]
    for address in addresses:
        try:
            probe(address, port)
        except ConnectionRefusedError:
            continue
        except OSError as error:
            if error.errno == errno.ECONNREFUSED:
                continue
            raise SystemExit('refusing: a loopback address of the database host neither accepted nor refused '
                             'a connection') from None
        return address
    raise SystemExit('refusing: no loopback address of the database host accepts connections on its port')


def checked_url(expected: str, environ=os.environ, connect=psycopg.connect, prefix: str = 'tcg_rb_',
                getaddrinfo=socket.getaddrinfo, probe=probe_address) -> str:
    """A connection string for the one database the stack created, built from libpq's own reading of the URL.

    Python's URL parser and libpq's disagree (a comma-separated host list, text after `#`), so the URL is parsed with
    libpq's parser and the effective parameters are checked: only user, password, host, port and dbname, exactly one
    loopback host, at most one numeric port, and a dbname that is exactly `expected`. The connection check and every
    write then use a string rebuilt from those parameters plus the effective port and one numeric loopback `hostaddr`
    (the host is resolved here, once, and every address it resolves to must be loopback), never the original text.
    When a name resolves to several addresses (`localhost` is often 127.0.0.1 and ::1), a plain TCP probe skips an
    address only if it refuses the connection; the first that accepts is checked, and nothing after the check connection
    falls through to another address. The server's own address is not checked: a loopback-published container (the CI
    service) reports its bridge address, not 127.0.0.1."""
    if not expected.startswith(prefix):
        raise SystemExit('refusing: the expected database is not a tcg_rb_* name')
    if any(environ.get(key) for key in ('PGHOSTADDR', 'PGSERVICE', 'PGSERVICEFILE')):
        raise SystemExit('refusing: the environment redirects the PostgreSQL connection')
    url = environ['RIFTBOUND_DATABASE_URL']
    if not url.startswith(('postgresql://', 'postgres://')):
        raise SystemExit('refusing: the database URL must be a PostgreSQL URL')
    try:
        params = conninfo_to_dict(url)
    except psycopg.ProgrammingError:
        raise SystemExit('refusing: the database URL is not readable') from None
    if set(params) - {'user', 'password', 'host', 'port', 'dbname'}:
        raise SystemExit('refusing: the database URL must carry no parameters')
    if params.get('host') not in LOOPBACK:  # a host list ("a,b") is not in LOOPBACK
        raise SystemExit('refusing: the database URL does not name exactly one loopback host')
    if 'port' in params and not (params['port'].isascii() and params['port'].isdigit()):
        raise SystemExit('refusing: the database URL does not name exactly one port')
    if params.get('dbname') != expected:
        raise SystemExit('refusing: the database URL does not name the expected database')
    port = libpq_port(params, environ)
    addresses = loopback_addresses(params['host'], getaddrinfo)
    checked = make_conninfo(**{**params, 'port': port}, hostaddr=choose_address(addresses, int(port), probe))
    try:
        with connect(checked) as conn:
            (name,) = conn.execute('SELECT current_database()').fetchone()
    except psycopg.Error as error:  # its text is not passed on; it names the host and may name the user
        raise SystemExit(f'refusing: the checked connection failed ({type(error).__name__})') from None
    if name != expected:
        raise SystemExit('refusing: the connection does not reach the expected database')
    return checked


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('name', choices=SCENARIOS)
    parser.add_argument('--database', required=True, help='the exact database the stack created')
    args = parser.parse_args()
    print(json.dumps(scenario(checked_url(args.database), args.name)))
