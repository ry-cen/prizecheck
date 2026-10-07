import os
from uuid import uuid4
from fastapi.testclient import TestClient
from app.main import app, connect
from test_catalog import headers


def test_operational_health_is_owner_only_and_reports_unverified_metrics():
    owner, other = 'ops-'+str(uuid4()), 'other-'+str(uuid4())
    with connect() as conn:
        conn.execute('DELETE FROM owner_binding')
        conn.execute('DELETE FROM operations_quota')
        conn.execute('DELETE FROM operations_counter')
        conn.execute('UPDATE operations_state SET backup_last_success=NULL,backup_stale=false')
        conn.execute('INSERT INTO inventory_owner(user_id) VALUES (%s),(%s)', (owner,other))
        conn.execute('INSERT INTO owner_binding(user_id) VALUES (%s)', (owner,))
    path = '/api/admin/operations'
    with TestClient(app) as client:
        assert client.get(path).status_code == 401
        assert client.get(path,headers=headers(other,'GET',path)).status_code == 403
        response = client.get(path,headers=headers(owner,'GET',path))
        assert response.status_code == 200
        body = response.json()
        assert body['provider_quotas'] == 'unverified'
        assert body['sign_in_delivery'] == 'unverified'
        assert body['backup_last_success'] is None
        assert body['backup_state'] == 'unverified'
        assert owner not in response.text and other not in response.text

def test_real_backup_watchdog_deduplicates_stale_condition(tmp_path):
    import json
    import subprocess
    import sys
    from pathlib import Path
    root = Path(__file__).resolve().parents[2]
    env = dict(os.environ,BACKUP_PRIVATE_DIR=str(tmp_path/'backups'))
    command = [sys.executable,str(root/'scripts/operations_job.py')]
    with connect() as conn:
        conn.execute('UPDATE operations_state SET backup_last_success=NULL,backup_alerts=0,backup_stale=false')
    result = subprocess.run(command+['backup'],env=env,capture_output=True)
    assert result.returncode == 0, result.stderr.decode()
    marker = json.loads((tmp_path/'backups'/'last-success.json').read_text())
    archive = tmp_path/'backups'/marker['snapshot']
    assert archive.is_file()
    import tarfile
    with tarfile.open(archive) as snapshot:
        assert 'manifest.json' in snapshot.getnames()
    with connect() as conn:
        assert conn.execute('SELECT backup_last_success FROM operations_state').fetchone()['backup_last_success'] is not None
    # Model35 actual daily backup objects using a known-good private snapshot.
    import shutil
    from datetime import datetime,timedelta,timezone
    for age in range(1,36):
        stamp=(datetime.now(timezone.utc)-timedelta(days=age)).strftime('%Y%m%dT%H%M%SZ')
        shutil.copyfile(archive,archive.parent/(stamp+'-'+uuid4().hex+'.tar.gz'))
    result=subprocess.run(command+['backup'],env=env,capture_output=True)
    assert result.returncode==0,result.stderr.decode()
    remaining=list(archive.parent.glob('*.tar.gz'))
    assert 7<=len(remaining)<=11
    days={datetime.strptime(item.name[:16],'%Y%m%dT%H%M%SZ').date() for item in remaining}
    weeks={day.isocalendar()[:2] for day in days}
    assert len(weeks)==4
    for age in range(7):
        assert (datetime.now(timezone.utc)-timedelta(days=age)).date() in days
    marker=json.loads((tmp_path/'backups'/'last-success.json').read_text())
    target='tcg_recovery_job_'+uuid4().hex
    try:
        restored=subprocess.run(command+['restore','--target',target],env=dict(env,RESTORE_ADMIN_DATABASE_URL=os.environ['DATABASE_URL']),capture_output=True)
        assert restored.returncode==0,restored.stderr.decode()
        with connect() as conn:
            assert conn.execute('SELECT restore_last_success FROM operations_state').fetchone()['restore_last_success'] is not None
    finally:
        import psycopg
        from psycopg import sql
        with psycopg.connect(os.environ['DATABASE_URL'],autocommit=True) as conn:
            conn.execute(sql.SQL('DROP DATABASE IF EXISTS {} WITH (FORCE)').format(sql.Identifier(target)))
    # Inject missed schedules through the durable marker, not a fake backup outcome.
    marker['completed_at'] = '2020-01-01T00:00:00+00:00'
    (tmp_path/'backups'/'last-success.json').write_text(json.dumps(marker))
    for _ in range(2):
        result = subprocess.run(command+['watchdog'],env=env,capture_output=True)
        assert result.returncode == 0, result.stderr.decode()
    with connect() as conn:
        state = conn.execute('SELECT backup_stale,backup_alerts FROM operations_state').fetchone()
        assert state == {'backup_stale':True,'backup_alerts':1}
        owner=conn.execute('SELECT user_id FROM owner_binding').fetchone()['user_id']
    with TestClient(app) as client:
        status=client.get('/api/admin/operations',headers=headers(owner,'GET','/api/admin/operations')).json()
        assert status['backup_state']=='stale' and status['backup_alerts']==1

def test_configured_quota_warns_at_seventy_percent_without_private_labels():
    import subprocess,sys
    from pathlib import Path
    path='/api/admin/operations'
    with connect() as conn:
        owner = conn.execute('SELECT user_id FROM owner_binding').fetchone()['user_id']
        conn.execute('DELETE FROM operations_quota')
    command=[sys.executable,str(Path(__file__).resolve().parents[2]/'scripts/operations_job.py'),'quota','--resource','database_bytes','--used','70','--allowance','100']
    result=subprocess.run(command,env=os.environ,capture_output=True)
    assert result.returncode==0,result.stderr.decode()
    with TestClient(app) as client:
        response=client.get(path,headers=headers(owner,'GET',path))
        assert response.status_code==200
        assert response.json()['provider_quotas']=='recorded'
        quota=response.json()['quotas'][0]
        assert quota['resource']=='database_bytes' and quota['warning'] is True and quota['verified'] is True

def test_eligible_watchdog_email_retries_same_alert_and_deduplicates(tmp_path):
    from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
    from threading import Thread
    import subprocess,sys
    from pathlib import Path
    sent=[]
    class Relay(BaseHTTPRequestHandler):
        def do_POST(self):
            sent.append((self.headers.get('Idempotency-Key'),self.rfile.read(int(self.headers['Content-Length']))))
            self.send_response(500 if len(sent)==1 else 204)
            self.end_headers()
        def log_message(self,*args): pass
    server=ThreadingHTTPServer(('127.0.0.1',0),Relay)
    worker=Thread(target=server.serve_forever,daemon=True);worker.start()
    owner='alert-'+str(uuid4())
    with connect() as conn:
        conn.execute('DELETE FROM owner_binding')
        conn.execute('DELETE FROM operations_alert')
        conn.execute('UPDATE operations_state SET backup_stale=false,backup_alerts=0')
        conn.execute('INSERT INTO inventory_owner(user_id) VALUES(%s)',(owner,))
        conn.execute('INSERT INTO owner_binding(user_id) VALUES(%s)',(owner,))
        conn.execute('INSERT INTO "user"(id,name,email,"emailVerified") VALUES(%s,\'Owner\',%s,true)',(owner,owner+'@example.test'))
    env=dict(os.environ,BACKUP_PRIVATE_DIR=str(tmp_path/'backups'),MAIL_MODE='http',MAIL_RELAY_URL=f'http://127.0.0.1:{server.server_port}',MAIL_RELAY_TOKEN='synthetic-relay-token',MAIL_FROM='alerts@example.test',MAIL_SENDER_VERIFIED='false')
    command=[sys.executable,str(Path(__file__).resolve().parents[2]/'scripts/operations_job.py'),'watchdog']
    try:
        assert subprocess.run(command,env=env,capture_output=True).returncode==0
        assert sent==[]
        env['MAIL_SENDER_VERIFIED']='true'
        first=subprocess.run(command,env=env,capture_output=True)
        assert first.returncode!=0
        assert b'@example.test' not in first.stderr and b'synthetic-relay-token' not in first.stderr
        assert subprocess.run(command,env=env,capture_output=True).returncode==0
        assert subprocess.run(command,env=env,capture_output=True).returncode==0
        assert len(sent)==2 and sent[0][0]==sent[1][0]
        with connect() as conn:
            assert conn.execute('SELECT count(*) AS n FROM operations_alert WHERE delivered_at IS NOT NULL').fetchone()['n']==1
            assert conn.execute('SELECT backup_alerts FROM operations_state').fetchone()['backup_alerts']==1
    finally:
        server.shutdown();server.server_close();worker.join()
