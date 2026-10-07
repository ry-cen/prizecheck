"""Portable scheduler entrypoints; no provider names or payloads in job results."""
import argparse
from datetime import datetime,timedelta,timezone
import json
import hashlib
import os
from pathlib import Path
import re
import sys
import tarfile
import tempfile
from uuid import uuid4
import psycopg
from recovery import backup,restore
from private_backup_store import configured_store
from operations_mail import deliver_pending

KEY = re.compile(r'^snapshots/(\d{8}T\d{6}Z)-[a-f0-9]{32}\.tar\.gz$')


def read_marker(store,directory):
    if 'last-success.json' not in store.list('last-success.json'):
        return None
    path = directory/'marker.json'
    store.get('last-success.json',path)
    marker = json.loads(path.read_text())
    if not KEY.fullmatch(marker['snapshot']):
        raise ValueError('Invalid marker')
    stamp = datetime.fromisoformat(marker['completed_at'])
    if stamp.tzinfo is None or stamp>datetime.now(timezone.utc)+timedelta(minutes=5):
        raise ValueError('Invalid marker timestamp')
    return marker


def retain(store,current):
    entries = []
    for key in store.list('snapshots/'):
        match = KEY.fullmatch(key)
        if not match:
            continue
        stamp = datetime.strptime(match[1],'%Y%m%dT%H%M%SZ').replace(tzinfo=timezone.utc)
        entries.append((stamp,key))
    days,weeks = {},{}
    for stamp,key in sorted(entries,reverse=True):
        days.setdefault(stamp.date(),key)
        weeks.setdefault(stamp.isocalendar()[:2],key)
    keep = set(list(days.values())[:7]+list(weeks.values())[:4]+[current])
    for _,key in entries:
        if key not in keep:
            store.delete(key)


def backup_job(url,store,directory):
    with psycopg.connect(url) as guard:
        if not guard.execute('SELECT pg_try_advisory_lock(18374491)').fetchone()[0]:
            raise ValueError('Backup already running')
        try:
            snapshot = directory/'snapshot'
            backup(url,snapshot)
            key = 'snapshots/'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'-'+uuid4().hex+'.tar.gz'
            archive = directory/'snapshot.tar.gz'
            with tarfile.open(archive,'w:gz') as tar:
                for path in snapshot.iterdir():
                    tar.add(path,arcname=path.name)
            store.put(key,archive)
            verified = directory/'verified.tar.gz'
            store.get(key,verified)
            with archive.open('rb') as expected,verified.open('rb') as actual:
                if hashlib.file_digest(expected,'sha256').digest()!=hashlib.file_digest(actual,'sha256').digest():
                    raise ValueError('Uploaded snapshot verification failed')
            completed = datetime.now(timezone.utc)
            marker = directory/'last-success.json'
            marker.write_text(json.dumps({'snapshot':key,'completed_at':completed.isoformat()}))
            store.put('last-success.json',marker)
            with psycopg.connect(url) as conn:
                conn.execute('UPDATE operations_state SET backup_last_success=%s,backup_stale=false WHERE singleton',(completed,))
                conn.execute("UPDATE operations_alert SET resolved_at=now() WHERE kind='backup_stale' AND resolved_at IS NULL")
            retain(store,key)
        except Exception:
            with psycopg.connect(url) as conn:
                conn.execute('UPDATE operations_state SET backup_failures=backup_failures+1 WHERE singleton')
            raise


def watchdog(url,store,directory):
    marker = read_marker(store,directory)
    stamp = datetime.fromisoformat(marker['completed_at']) if marker else None
    stale = stamp is None or datetime.now(timezone.utc)-stamp>timedelta(hours=25)
    with psycopg.connect(url) as conn:
        state = conn.execute('SELECT backup_stale FROM operations_state WHERE singleton FOR UPDATE').fetchone()
        new_alert = stale and not state[0]
        conn.execute('UPDATE operations_state SET backup_last_success=%s,backup_stale=%s,backup_alerts=backup_alerts+%s,watchdog_last_check=now() WHERE singleton',(stamp,stale,int(new_alert)))
        if new_alert:
            conn.execute("INSERT INTO operations_alert(kind) VALUES ('backup_stale') ON CONFLICT DO NOTHING")
        if not stale:
            conn.execute("UPDATE operations_alert SET resolved_at=now() WHERE kind='backup_stale' AND resolved_at IS NULL")
    deliver_pending(url)
    return stale


def restore_job(url,store,directory,target):
    marker = read_marker(store,directory)
    if not marker:
        raise ValueError('No verified backup marker')
    archive = directory/'snapshot.tar.gz'
    store.get(marker['snapshot'],archive)
    snapshot = directory/'snapshot'
    snapshot.mkdir(mode=0o700)
    with tarfile.open(archive,'r:gz') as tar:
        # Only regular flat files are valid recovery artifacts; no links or devices.
        if any(not item.isfile() or Path(item.name).name!=item.name for item in tar.getmembers()):
            raise ValueError('Unsafe backup archive')
        tar.extractall(snapshot,filter='data')
    try:
        restore(os.environ['RESTORE_ADMIN_DATABASE_URL'],snapshot,target)
        with psycopg.connect(url) as conn:
            conn.execute('UPDATE operations_state SET restore_last_success=now() WHERE singleton')
    except Exception:
        with psycopg.connect(url) as conn:
            conn.execute('UPDATE operations_state SET restore_failures=restore_failures+1 WHERE singleton')
        raise


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('command',choices=['backup','watchdog','restore','quota'])
    parser.add_argument('--target')
    parser.add_argument('--resource',choices=['database_bytes','storage_bytes','email_monthly','requests_monthly','runtime_ms'])
    parser.add_argument('--used',type=int)
    parser.add_argument('--allowance',type=int)
    args = parser.parse_args()
    try:
        if args.command=='quota':
            if args.resource is None or args.used is None or args.used<0 or args.allowance is None or args.allowance<=0:
                raise ValueError('Positive allowance and nonnegative use required')
            with psycopg.connect(os.environ['DATABASE_URL']) as conn:
                conn.execute('INSERT INTO operations_quota(resource,used,allowance) VALUES(%s,%s,%s) ON CONFLICT(resource) DO UPDATE SET used=excluded.used,allowance=excluded.allowance,measured_at=now()', (args.resource,args.used,args.allowance))
            print('{"status":"ok"}')
            return 0
        store = configured_store()
        with tempfile.TemporaryDirectory() as work:
            directory = Path(work)
            url = os.environ['DATABASE_URL']
            if args.command=='backup': backup_job(url,store,directory)
            elif args.command=='watchdog': watchdog(url,store,directory)
            else:
                if not args.target: raise ValueError('Disposable target required')
                restore_job(url,store,directory,args.target)
        print('{"status":"ok"}')
        return 0
    except Exception:
        print('Operational job failed; inspect sanitized owner status.',file=sys.stderr)
        return 1

if __name__=='__main__': sys.exit(main())
