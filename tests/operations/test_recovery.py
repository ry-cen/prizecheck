import json
import os
from pathlib import Path
import subprocess
import unittest
import uuid
import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo

ROOT = Path(__file__).resolve().parents[2]

class RecoveryTest(unittest.TestCase):
    def test_backup_rejects_public_projection_storage(self):
        import tempfile
        with tempfile.TemporaryDirectory() as public:
            destination = Path(public)/'private-backup'
            env = dict(os.environ, DATABASE_URL=os.environ['RECOVERY_TEST_DATABASE_URL'], PUBLIC_PROJECTION_DIR=public)
            run = subprocess.run([str(ROOT/'.venv/bin/python'), str(ROOT/'scripts/recovery.py'), 'backup', str(destination)], env=env, capture_output=True)
            self.assertNotEqual(run.returncode,0)
            self.assertFalse(destination.exists())

    def test_backup_rejects_default_public_store_without_configuration(self):
        import tempfile
        with tempfile.TemporaryDirectory() as workspace:
            public = Path(workspace)/'.local/public-projections'
            public.mkdir(parents=True)
            destination = public/'private-backup'
            env = dict(os.environ, DATABASE_URL=os.environ['RECOVERY_TEST_DATABASE_URL'])
            env.pop('PUBLIC_PROJECTION_DIR',None)
            run = subprocess.run([str(ROOT/'.venv/bin/python'), str(ROOT/'scripts/recovery.py'), 'backup', str(destination)], cwd=workspace, env=env, capture_output=True)
            self.assertNotEqual(run.returncode,0)
            self.assertFalse(destination.exists())

    def test_backup_rejects_empty_public_store_configuration(self):
        import tempfile
        with tempfile.TemporaryDirectory() as workspace:
            destination = Path(workspace)/'private-backup'
            env = dict(os.environ, DATABASE_URL=os.environ['RECOVERY_TEST_DATABASE_URL'], PUBLIC_PROJECTION_DIR='')
            run = subprocess.run([str(ROOT/'.venv/bin/python'), str(ROOT/'scripts/recovery.py'), 'backup', str(destination)], cwd=workspace, env=env, capture_output=True)
            self.assertNotEqual(run.returncode,0)
            self.assertFalse(destination.exists())

    def test_backup_refuses_role_without_sequence_visibility(self):
        admin = os.environ['RECOVERY_TEST_DATABASE_URL']
        suffix = uuid.uuid4().hex
        source = 'tcg_recovery_restricted_' + suffix
        role = 'tcg_recovery_role_' + suffix
        password = uuid.uuid4().hex
        backup = Path('/tmp')/('tcg-recovery-restricted-'+suffix)
        with psycopg.connect(admin,autocommit=True) as conn:
            conn.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(source)))
            conn.execute(sql.SQL('CREATE ROLE {} LOGIN PASSWORD {}').format(sql.Identifier(role),sql.Literal(password)))
        source_url = make_conninfo(admin,dbname=source)
        try:
            subprocess.run([str(ROOT/'.venv/bin/python'),str(ROOT/'scripts/migrate.py')],env=dict(os.environ,DATABASE_URL=source_url),check=True,capture_output=True)
            with psycopg.connect(source_url) as conn:
                conn.execute("INSERT INTO auth_send_event(email_key,ip_key) VALUES ('private-hash','private-hash')")
                conn.execute(sql.SQL('GRANT USAGE ON SCHEMA public TO {}').format(sql.Identifier(role)))
                conn.execute(sql.SQL('GRANT SELECT ON ALL TABLES IN SCHEMA public TO {}').format(sql.Identifier(role)))
            restricted = make_conninfo(source_url,user=role,password=password)
            # A real PostgreSQL role can read rows while pg_sequences masks last_value.
            with psycopg.connect(restricted) as conn:
                self.assertEqual(conn.execute('SELECT count(*) FROM auth_send_event').fetchone(),(1,))
                self.assertIsNone(conn.execute("SELECT last_value FROM pg_sequences WHERE sequencename='auth_send_event_id_seq'").fetchone()[0])
            run = subprocess.run([str(ROOT/'.venv/bin/python'),str(ROOT/'scripts/recovery.py'),'backup',str(backup)],env=dict(os.environ,DATABASE_URL=restricted),capture_output=True)
            self.assertNotEqual(run.returncode,0)
            self.assertFalse(backup.exists())
            self.assertNotIn(b'private-hash',run.stderr)
        finally:
            with psycopg.connect(admin,autocommit=True) as conn:
                conn.execute(sql.SQL('DROP DATABASE {} WITH (FORCE)').format(sql.Identifier(source)))
                conn.execute(sql.SQL('DROP ROLE {}').format(sql.Identifier(role)))
            import shutil
            shutil.rmtree(backup,ignore_errors=True)

    def test_private_snapshot_restores_identity_and_rejects_existing_target(self):
        admin = os.environ['RECOVERY_TEST_DATABASE_URL']
        suffix = uuid.uuid4().hex
        source, target = 'tcg_recovery_source_' + suffix, 'tcg_recovery_restore_' + suffix
        backup = Path('/tmp') / ('tcg-recovery-' + suffix)
        with psycopg.connect(admin, autocommit=True) as conn:
            conn.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(source)))
        source_url = make_conninfo(admin, dbname=source)
        env = dict(os.environ, DATABASE_URL=source_url)
        try:
            subprocess.run([str(ROOT / '.venv/bin/python'), str(ROOT / 'scripts/migrate.py')], env=env, check=True, capture_output=True)
            with psycopg.connect(source_url) as conn:
                conn.execute("INSERT INTO inventory_owner(user_id) VALUES ('owner')")
                identity = conn.execute("INSERT INTO catalog_identity(identity_key,display_name) VALUES ('pikachu','Pikachu') RETURNING id").fetchone()[0]
                printing = conn.execute("INSERT INTO catalog_printing(source,identity_id) VALUES ('manual',%s) RETURNING id", (identity,)).fetchone()[0]
                edition = conn.execute("INSERT INTO catalog_edition(printing_id,descriptor_key,descriptor) VALUES (%s,'unspecified','{}') RETURNING id", (printing,)).fetchone()[0]
                location = uuid.uuid4()
                conn.execute("INSERT INTO location(id,owner_id,name,kind) VALUES (%s,'owner','Unsorted','storage_leaf')", (location,))
                conn.execute("INSERT INTO holding VALUES ('owner',%s,%s,42,3)", (location, edition))
                conn.execute("INSERT INTO catalog_printing_display VALUES (%s,'Pikachu','manual','Manual set','7',NULL)", (printing,))
                report = conn.execute("INSERT INTO missing_card_report(reporter_id,kind,status,approved_printing_id,approved_edition_id) VALUES ('owner','printing','approved',%s,%s) RETURNING id", (printing,edition)).fetchone()[0]
                conn.execute("INSERT INTO catalog_override(report_id,printing_id,edition_id,revision,reviewer_id,evidence_url,reason,action) VALUES (%s,%s,%s,1,'owner','https://example.test/evidence','reviewed','approve_printing')", (report,printing,edition))
                conn.execute("INSERT INTO deck_publication(token,owner_id,deck_id,title,revoked) VALUES ('burned-test-token','owner',%s,'Private title',true)", (location,))
                conn.execute("INSERT INTO publication_command(owner_id,request_key,request_digest,token,result) VALUES ('owner',%s,'digest','burned-test-token','{}')", (uuid.uuid4(),))
                conn.execute("INSERT INTO inventory_undo(id,owner_id,action,source_id,payload) VALUES (%s,'owner','remove',%s,'{}')", (uuid.uuid4(),location))
                conn.execute("INSERT INTO inventory_undo(id,owner_id,action,source_id,expires_at,payload) VALUES (%s,'owner','remove',%s,now()-interval '1 minute','{\"private\":\"expired\"}')", (uuid.uuid4(), location))
            run = subprocess.run([str(ROOT / '.venv/bin/python'), str(ROOT / 'scripts/recovery.py'), 'backup', str(backup)], env=env, capture_output=True)
            self.assertEqual(run.returncode, 0, run.stderr.decode())
            self.assertEqual(backup.stat().st_mode & 0o777, 0o700)
            manifest = json.loads((backup/'manifest.json').read_text())
            self.assertEqual(manifest['rows']['inventory_undo'], 1)
            restored_env = dict(os.environ, DATABASE_URL=admin)
            cmd = [str(ROOT / '.venv/bin/python'), str(ROOT / 'scripts/recovery.py'), 'restore', str(backup), target]
            restored = subprocess.run(cmd, env=restored_env, capture_output=True)
            self.assertEqual(restored.returncode, 0, restored.stderr.decode())
            with psycopg.connect(make_conninfo(admin, dbname=target)) as conn:
                self.assertEqual(conn.execute('SELECT edition_id,quantity,version FROM holding').fetchall(), [(edition,42,3)])
                self.assertEqual(conn.execute('SELECT id FROM catalog_printing').fetchall(), [(printing,)])
                self.assertEqual(conn.execute('SELECT printing_id,edition_id FROM catalog_override').fetchall(), [(printing,edition)])
                self.assertEqual(conn.execute('SELECT revoked FROM deck_publication').fetchall(), [(True,)])
                self.assertEqual(conn.execute('SELECT projected FROM publication_command').fetchall(), [(False,)])
                self.assertEqual(conn.execute('SELECT sequence FROM publication_command').fetchall(), [(1,)])
                self.assertEqual(conn.execute("SELECT nextval('publication_command_sequence_seq')").fetchone(), (2,))
                self.assertEqual(conn.execute("SELECT nextval('auth_send_event_id_seq')").fetchone(), (1,))
                self.assertEqual(conn.execute('SELECT active_generation,last_success FROM catalog_state').fetchall(), [(None,None)])
            refused = subprocess.run(cmd, env=restored_env, capture_output=True)
            self.assertNotEqual(refused.returncode, 0)
            self.assertNotIn(b'owner', refused.stderr)
            (backup/'pre.sql').write_text('tampered')
            corrupt_cmd = cmd[:-1] + [target+'_corrupt']
            corrupt = subprocess.run(corrupt_cmd, env=restored_env, capture_output=True)
            self.assertNotEqual(corrupt.returncode,0)
            with psycopg.connect(admin) as conn:
                self.assertIsNone(conn.execute('SELECT 1 FROM pg_database WHERE datname=%s', (target+'_corrupt',)).fetchone())
        finally:
            with psycopg.connect(admin, autocommit=True) as conn:
                for name in (source,target):
                    conn.execute(sql.SQL('DROP DATABASE IF EXISTS {} WITH (FORCE)').format(sql.Identifier(name)))
            import shutil
            shutil.rmtree(backup, ignore_errors=True)
