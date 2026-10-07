"""Portable manual releases. Trusted local gate store is not external CI attestation."""
import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.error
import urllib.request

import psycopg
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict
from urllib.parse import urlsplit, urlunsplit

ROOT = Path(__file__).resolve().parents[1]


def run(args, cwd, env=None, log=None):
    subprocess.run(args,cwd=cwd,env=env,check=True,stdout=log or subprocess.DEVNULL,stderr=log or subprocess.DEVNULL)


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream,'sha256').hexdigest()


def verify(path):
    receipt = json.loads((path/'release.json').read_text())
    if receipt.get('gate') != 'fixed-ci-v2':
        raise ValueError('No trusted gate receipt')
    actual = {str(p.relative_to(path)):digest(p) for p in path.rglob('*') if p.is_file() and p != path/'release.json'}
    if actual != receipt['files']:
        raise ValueError('Release integrity mismatch')
    return receipt


@contextmanager
def locked(store):
    store.mkdir(mode=0o700,parents=True,exist_ok=True)
    with (store/'.lock').open('a') as stream:
        fcntl.flock(stream,fcntl.LOCK_EX)
        yield


def dependencies(checkout,runtime):
    for name in ('.venv','node_modules'):
        if not (runtime/name).exists():
            raise ValueError('Installed Python and Node dependencies required')
        (checkout/name).symlink_to((runtime/name).resolve(),target_is_directory=True)


def runtime_fingerprint(runtime):
    fingerprint = hashlib.sha256()
    for directory in (runtime/'.venv',runtime/'node_modules'):
        for path in sorted(directory.rglob('*')):
            if not path.is_file() or any(part in ('__pycache__','.cache','.vite','.vite-temp') for part in path.parts) or path.suffix == '.pyc':
                continue
            fingerprint.update(str(path.relative_to(runtime)).encode()+b'\0'+digest(path).encode()+b'\0')
    fingerprint.update(digest(Path(shutil.which('node'))).encode())
    return fingerprint.hexdigest()


def local_url(url):
    if urlsplit(url).scheme not in ('postgresql','postgres'):
        raise ValueError('PostgreSQL URL required by Python and Node boundaries')
    options = conninfo_to_dict(url)
    if options.get('host') not in ('127.0.0.1','localhost','::1') or options.get('hostaddr','127.0.0.1') not in ('127.0.0.1','::1'):
        raise ValueError('Explicit loopback database required')


def compatible(previous,candidate):
    old = {p.name:digest(p) for p in (previous/'migrations').glob('*.sql')}
    new = {p.name:digest(p) for p in (candidate/'migrations').glob('*.sql')}
    if any(new.get(name) != sha for name,sha in old.items()):
        raise ValueError('Existing migrations removed or changed')


def gate(args):
    selected = subprocess.check_output(['git','rev-parse',args.commit+'^{commit}'],cwd=ROOT,text=True).strip()
    if not args.main_ref.startswith('refs/heads/'):
        raise ValueError('Explicit selected main branch required')
    main = subprocess.check_output(['git','rev-parse',args.main_ref+'^{commit}'],cwd=ROOT,text=True).strip()
    if selected != main:
        raise ValueError('Exact main commit required')
    local_url(args.admin_url)
    store = args.store.resolve()
    runtime = args.runtime.resolve()
    with locked(store), tempfile.TemporaryDirectory(prefix='tcg-release-gate-') as temp:
        checkout = Path(temp)/'checkout'
        checkout.mkdir()
        archive = subprocess.check_output(['git','archive',selected],cwd=ROOT)
        archive_path = Path(temp)/'source.tar'
        archive_path.write_bytes(archive)
        with tarfile.open(archive_path) as source:
            source.extractall(checkout,filter='data')
        dependencies(checkout,runtime)
        name = 'tcg_release_'+secrets.token_hex(8)
        with psycopg.connect(args.admin_url,autocommit=True) as conn:
            conn.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(name)))
        env = {'PATH':os.environ['PATH'],'HOME':temp,'DATABASE_URL':urlunsplit(urlsplit(args.admin_url)._replace(path='/'+name)),
               'PLAYWRIGHT_BROWSERS_PATH':os.environ.get('PLAYWRIGHT_BROWSERS_PATH',str(Path.home()/'Library/Caches/ms-playwright'))}
        try:
            with (store/('ci-'+selected+'-'+secrets.token_hex(4)+'.log')).open('wb') as log:
                run(['bash','scripts/ci.sh'],checkout,env,log)
            compatibility = 'first release; no previous release available'
            previous_commit = None
            active = store/'active'
            if active.is_symlink():
                previous = active.resolve()
                previous_commit = verify(previous)['commit']
                compatible(previous,checkout)
                old = Path(temp)/'previous'
                shutil.copytree(previous,old)
                for path in [old,*old.rglob('*')]:
                    path.chmod(0o700 if path.is_dir() else 0o600)
                (old/'release.json').unlink()
                dependencies(old,runtime)
                # Candidate migrations already installed. Old application suite must pass on that schema.
                with (store/('compatibility-'+selected+'-'+secrets.token_hex(4)+'.log')).open('wb') as log:
                    run(['bash','scripts/ci.sh'],old,env,log)
                compatibility = 'previous fixed CI passed against candidate schema; unchanged migration prefix'
        finally:
            with psycopg.connect(args.admin_url,autocommit=True) as conn:
                conn.execute(sql.SQL('DROP DATABASE {} WITH (FORCE)').format(sql.Identifier(name)))
        (checkout/'.venv').unlink()
        (checkout/'node_modules').unlink()
        for path in checkout.rglob('__pycache__'):
            shutil.rmtree(path)
        for path in (checkout/'.pytest_cache',checkout/'test-results',checkout/'playwright-report'):
            if path.exists():
                shutil.rmtree(path)
        files = {str(p.relative_to(checkout)):digest(p) for p in checkout.rglob('*') if p.is_file()}
        receipt = {'gate':'fixed-ci-v2','commit':selected,'main_ref':args.main_ref,'previous_commit':previous_commit,'files':files,'compatibility':compatibility,
                   'runtime_fingerprint':runtime_fingerprint(runtime),'scope':'local fixed CI; external CI identity and provider production proof pending'}
        (checkout/'release.json').write_text(json.dumps(receipt,sort_keys=True))
        destination = store/selected
        if destination.exists():
            raise ValueError('Immutable release already exists')
        shutil.copytree(checkout,destination)
        for path in destination.rglob('*'):
            path.chmod(0o555 if path.is_dir() else 0o444)
        destination.chmod(0o555)
        print(json.dumps({'status':'gated','commit':selected,'compatibility':compatibility}))


def runtime_request(url,key,path,body=None):
    from urllib.parse import urlparse
    parsed = urlparse(url)
    if parsed.scheme != 'http' or parsed.hostname not in ('127.0.0.1','localhost','::1') or parsed.path not in ('','/'):
        raise ValueError('Explicit local runtime adapter required')
    request = urllib.request.Request(url.rstrip('/')+path,data=None if body is None else json.dumps(body).encode(),
                                     headers={'x-release-key':key,'Content-Type':'application/json'})
    with urllib.request.urlopen(request,timeout=30) as response:
        return json.loads(response.read())


def smoke(url,release):
    import re
    for route,status in [('/api/health',200),('/api/locations',401),('/api/public/decks/unknown-smoke-token',404)]:
        try:
            with urllib.request.urlopen(url.rstrip('/')+route,timeout=5) as response:
                actual = response.status
        except urllib.error.HTTPError as error:
            actual = error.code
        if actual != status:
            raise ValueError('Protected/public smoke failed')
    with urllib.request.urlopen(url.rstrip('/')+'/',timeout=5) as response:
        content = response.read()
        if content != (release/'dist/web/index.html').read_bytes():
            raise ValueError('Wrong active assets')
        html = content.decode()
    assets = re.findall(r'(?:src|href)="(/assets/[^" ]+)"',html)
    if not assets:
        raise ValueError('Built assets missing')
    for asset in assets:
        with urllib.request.urlopen(url.rstrip('/')+asset,timeout=5) as response:
            expected = (release/'dist/web'/asset.lstrip('/')).resolve()
            if (release/'dist/web').resolve() not in expected.parents or response.status != 200 or response.read() != expected.read_bytes():
                raise ValueError('Asset smoke failed')


def switch(args):
    store,runtime = args.store.resolve(),args.runtime.resolve()
    with locked(store):
        active = store/'active'
        previous_link = store/'previous'
        if args.command == 'rollback':
            if not previous_link.is_symlink():
                raise ValueError('No previous compatible release')
            target = previous_link.resolve()
        else:
            if len(args.commit) != 40 or any(c not in '0123456789abcdef' for c in args.commit):
                raise ValueError('Full release commit required')
            target = store/args.commit
        if target.parent != store:
            raise ValueError('Release outside private store')
        receipt = verify(target)
        if receipt['runtime_fingerprint'] != runtime_fingerprint(runtime):
            raise ValueError('Installed runtime differs from tested release')
        env = dict(os.environ)
        local_url(env['DATABASE_URL'])
        if not env.get('PUBLIC_PROJECTION_DIR'):
            raise ValueError('Explicit local projection store required')
        if active.is_symlink():
            current = active.resolve()
            verify(current)
            current_receipt = verify(current)
            if args.command == 'rollback' and current_receipt['previous_commit'] != receipt['commit']:
                raise ValueError('No tested rollback relationship')
            if args.command != 'rollback' and receipt['previous_commit'] != current_receipt['commit']:
                raise ValueError('Gate is not bound to current release')
            compatible(target,current) if args.command == 'rollback' else compatible(current,target)
        else:
            current = None
        if current is None and receipt['previous_commit'] is not None:
            raise ValueError('Expected previous release missing')
        key = env.get('RELEASE_CONTROL_KEY','')
        if len(key) < 32:
            raise ValueError('Private runtime control key required')
        observed = runtime_request(args.runtime_url,key,'/__release/status')['commit']
        if observed != (current.name if current else None):
            raise ValueError('Runtime and recorded release differ')
        if args.command != 'rollback':
            run([str(runtime/'.venv/bin/python'),str(target/'scripts/migrate.py')],target,env)
        try:
            applied = runtime_request(args.runtime_url,key,'/__release/apply',{'commit':target.name})
            if applied.get('commit') != target.name:
                raise ValueError('Runtime applied wrong release')
            smoke(args.runtime_url,target)
        except Exception:
            if current is not None:
                runtime_request(args.runtime_url,key,'/__release/apply',{'commit':current.name})
                smoke(args.runtime_url,current)
            else:
                runtime_request(args.runtime_url,key,'/__release/clear',{})
            raise
        if current is not None:
            temp = store/'.previous-next'
            temp.symlink_to(current.name,target_is_directory=True)
            os.replace(temp,previous_link)
        temp = store/'.active-next'
        temp.symlink_to(target.name,target_is_directory=True)
        os.replace(temp,active)
        print(json.dumps({'status':args.command,'commit':target.name,'smoke':'protected/public/assets passed'}))


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command',required=True)
    for name in ('gate','activate','rollback'):
        sub = commands.add_parser(name)
        sub.add_argument('--store',type=Path,required=True)
        sub.add_argument('--runtime',type=Path,default=ROOT)
        if name != 'rollback':
            sub.add_argument('--commit',required=True)
        if name != 'gate':
            sub.add_argument('--runtime-url',required=True)
        if name == 'gate':
            sub.add_argument('--main-ref',default='refs/heads/main')
            sub.add_argument('--admin-url',required=True)
    args = parser.parse_args()
    try:
        gate(args) if args.command == 'gate' else switch(args)
    except ValueError as error:
        print(str(error),file=sys.stderr)
        return 1
    except Exception:
        print('Local release failed; activation unchanged. Check private runtime configuration.',file=sys.stderr)
        return 1
    return 0

if __name__ == '__main__':
    sys.exit(main())
