"""Trusted local private logical backups; production storage/scheduling remain pending."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

import psycopg
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict, make_conninfo

EXCLUDED = {'catalog_generation', 'catalog_generation_printing', 'catalog_generation_edition', 'catalog_run'}
EXPIRING = {'inventory_undo', 'move_manifest', 'mutation_request', 'catalog_approval_code'}


def pg_env(url):
    env = dict(os.environ)
    names = {'host':'PGHOST','port':'PGPORT','dbname':'PGDATABASE','user':'PGUSER','password':'PGPASSWORD','sslmode':'PGSSLMODE'}
    for key, value in conninfo_to_dict(url).items():
        if key not in names:
            raise ValueError('Unsupported connection option')
        env[names[key]] = value
    return env


def dump_schema(env, snapshot, section, path):
    with path.open('wb') as output:
        subprocess.run(['pg_dump', '--no-password', '--no-owner', '--no-privileges', '--schema-only', '--schema=public',
                        '--snapshot=' + snapshot, '--section=' + section], env=env,
                       stdout=output, stderr=subprocess.PIPE, check=True)


def backup(url, destination):
    destination = Path(destination).resolve()
    public = os.environ.get('PUBLIC_PROJECTION_DIR', '.local/public-projections')
    if not public.strip():
        raise ValueError('Public storage configuration cannot be empty')
    if destination == Path(public).resolve() or Path(public).resolve() in destination.parents:
        raise ValueError('Private backup cannot use public storage')
    # mkdir is exclusive: an existing object is never overwritten.
    destination.mkdir(mode=0o700)
    try:
        with psycopg.connect(url) as conn:
            conn.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
            snapshot, cutoff = conn.execute('SELECT pg_export_snapshot(), transaction_timestamp()').fetchone()
            hidden_sequence = conn.execute("""
                SELECT 1 FROM pg_sequences
                WHERE schemaname='public'
                  AND NOT has_sequence_privilege(format('%I.%I',schemaname,sequencename),'SELECT,USAGE')
                LIMIT 1
            """).fetchone()
            if hidden_sequence:
                raise ValueError('Backup role cannot read sequence high-water marks')
            env = pg_env(url)
            dump_schema(env, snapshot, 'pre-data', destination/'pre.sql')
            dump_schema(env, snapshot, 'post-data', destination/'post.sql')
            rows = {}
            tables = conn.execute("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename").fetchall()
            for (table,) in tables:
                if table in EXCLUDED:
                    continue
                query = sql.SQL('SELECT * FROM {}').format(sql.Identifier(table))
                if table in EXPIRING:
                    query += sql.SQL(' WHERE expires_at > {}').format(sql.Literal(cutoff))
                elif table == 'move_manifest_item':
                    query += sql.SQL(' WHERE owner_id IN (SELECT owner_id FROM move_manifest WHERE expires_at > {})').format(sql.Literal(cutoff))
                elif table in {'mutation_response', 'move_response'}:
                    query += sql.SQL(' WHERE (owner_id,request_key) IN (SELECT owner_id,request_key FROM mutation_request WHERE expires_at > {})').format(sql.Literal(cutoff))
                elif table in {'session','verification'}:
                    query += sql.SQL(' WHERE "expiresAt" > {}').format(sql.Literal(cutoff))
                if table == 'catalog_state':
                    query = sql.SQL('SELECT singleton,NULL::uuid AS active_generation,revision,NULL::timestamptz AS last_success FROM catalog_state')
                rows[table] = conn.execute(sql.SQL('SELECT count(*) FROM ({}) AS backed_up').format(query)).fetchone()[0]
                with (destination/(table+'.copy')).open('wb') as output:
                    with conn.cursor().copy(sql.SQL('COPY ({}) TO STDOUT WITH (FORMAT binary)').format(query)) as stream:
                        for chunk in stream:
                            output.write(chunk)
            # Sequence high-water marks can safely run ahead of the snapshot, never behind.
            sequences = conn.execute("SELECT sequencename,last_value FROM pg_sequences WHERE schemaname='public'").fetchall()
            with (destination/'sequences.sql').open('w') as output:
                for name, value in sequences:
                    if value is not None:
                        output.write(sql.SQL('SELECT setval({}, {}, true);\n').format(sql.Literal('public.'+name),sql.Literal(value)).as_string(conn))
        files = {}
        for path in destination.iterdir():
            with path.open('rb') as source:
                files[path.name] = hashlib.file_digest(source, 'sha256').hexdigest()
        (destination/'manifest.json').write_text(json.dumps({'format':1,'snapshot_at':cutoff.isoformat(),'rows':rows,'files':files},sort_keys=True))
        for path in destination.iterdir():
            path.chmod(0o600)
    except Exception:
        import shutil
        shutil.rmtree(destination)
        raise


def restore(admin_url, directory, target):
    if not re.fullmatch(r'tcg_recovery_[a-z0-9_]+', target):
        raise ValueError('Target must be a new tcg_recovery_ disposable database')
    directory = Path(directory)
    manifest = json.loads((directory/'manifest.json').read_text())
    if manifest['format'] != 1:
        raise ValueError('Unsupported backup')
    for name, digest in manifest['files'].items():
        if Path(name).name != name:
            raise ValueError('Invalid backup filename')
        with (directory/name).open('rb') as source:
            if hashlib.file_digest(source, 'sha256').hexdigest() != digest:
                raise ValueError('Backup checksum mismatch')
    with psycopg.connect(admin_url, autocommit=True) as admin:
        # CREATE DATABASE fails safely for every existing target, even empty ones.
        admin.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(target)))
    url = make_conninfo(admin_url, dbname=target)
    env = pg_env(url)
    try:
        with psycopg.connect(url) as conn:
            conn.execute('DROP SCHEMA public')
        for phase in ('pre', 'data', 'sequences', 'post'):
            if phase == 'data':
                with psycopg.connect(url) as conn:
                    for table in manifest['rows']:
                        with (directory/(table+'.copy')).open('rb') as source:
                            with conn.cursor().copy(sql.SQL('COPY {} FROM STDIN WITH (FORMAT binary)').format(sql.Identifier(table))) as stream:
                                while chunk := source.read(1024*1024):
                                    stream.write(chunk)
            else:
                subprocess.run(['psql','--no-password','-X','--set=ON_ERROR_STOP=1','--file='+str(directory/(phase+'.sql'))],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,check=True)
        with psycopg.connect(url) as conn:
            for table, count in manifest['rows'].items():
                actual = conn.execute(sql.SQL('SELECT count(*) FROM {}').format(sql.Identifier(table))).fetchone()[0]
                if actual != count:
                    raise ValueError('Restored row count mismatch')
        # Post-data application validates foreign keys/checks/unique indexes against all rows.
        print(json.dumps({'status':'verified','tables':len(manifest['rows']),'catalog_reimport_required':True}))
    except Exception:
        # Only this invocation's freshly created target is removed on failure.
        with psycopg.connect(admin_url, autocommit=True) as admin:
            admin.execute(sql.SQL('DROP DATABASE {} WITH (FORCE)').format(sql.Identifier(target)))
        raise


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='command',required=True)
    sub.add_parser('backup').add_argument('directory')
    rest = sub.add_parser('restore')
    rest.add_argument('directory')
    rest.add_argument('target')
    args = parser.parse_args()
    try:
        url = os.environ['DATABASE_URL']
        if args.command == 'backup':
            backup(url,args.directory)
            print('{"status":"created"}')
        else:
            restore(url,args.directory,args.target)
    except Exception:
        # DB/subprocess exceptions may contain credentials, emails, tokens or card data.
        print('Recovery operation failed; no existing database was overwritten.',file=sys.stderr)
        return 1
    return 0

if __name__ == '__main__':
    sys.exit(main())
