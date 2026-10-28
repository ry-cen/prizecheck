"""The host script's configuration checks (deploy/host/prizecheck-deploy.sh): `check-config` and `bundle-digest` run
against a scratch PRIZECHECK_HOME. Docker is absent or faked (the published-port check reads Compose's rendered model). Production refuses what the auth gateway would reject under
NODE_ENV=production, or what would expose the web port; a dev file keeps passing as it did. Each case checks the exit code
and a stable substring of the message (which names a key, never a value)."""
import hashlib
import json
from pathlib import Path
import os
import shutil
import subprocess
import stat
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / 'deploy/host/prizecheck-deploy.sh'
POSTGRES = 'a1b2c3d4e5' * 4
SECRET = 'f6e5d4c3b2a1' * 4
PROD = [
    'PRIZECHECK_ENVIRONMENT=prod', 'PRIZECHECK_PROJECT=prizecheck-prod', 'PUBLIC_ORIGIN=https://prizecheck.example.com',
    'OWNER_EMAIL=o@example.com', f'POSTGRES_PASSWORD={POSTGRES}', f'BETTER_AUTH_SECRET={SECRET}',
    f'INTERNAL_AUTH_SECRET={SECRET}', 'MAIL_MODE=http', 'EMAIL_SIGN_IN=off', 'GOOGLE_CLIENT_ID=id',
    'GOOGLE_CLIENT_SECRET=secret',
]
DEV = [
    'PRIZECHECK_PROJECT=prizecheck-dev', 'PRIZECHECK_WEB_BIND=127.0.0.1', 'PRIZECHECK_WEB_PORT=8088',
    'PUBLIC_ORIGIN=https://unraid.example.ts.net', 'OWNER_EMAIL=o@example.com', f'POSTGRES_PASSWORD={POSTGRES}',
    f'BETTER_AUTH_SECRET={SECRET}', f'INTERNAL_AUTH_SECRET={SECRET}', 'MAIL_MODE=file', 'EMAIL_SIGN_IN=on',
]
WARNING = 'no mail relay'
COMMIT = 'ab12' * 10
OTHER = 'cd34' * 10
TSX = ROOT / 'node_modules/.bin/tsx'
PROOF = {
    'schemaVersion': 2, 'releaseCommit': COMMIT, 'authorizedByOwner': True, 'ownerWalkthroughVerified': True,
    'recoveryVerified': True, 'privacyVerified': True, 'capacityVerified': True, 'providerSignInVerified': ['google'],
    'evidence': 'dated acceptance notes',
}
# A `docker` for the signup tests. `compose run ... auth node -e <js>` runs the script's own readiness check through
# the gateway's real signup module (tsx), with the environment the auth service would get; every other call is
# recorded (with the PRIZECHECK_SIGNUP_MODE it was given) and succeeds.
FAKE_DOCKER = r'''#!PYTHON
import json, os, subprocess, sys, tempfile
args = sys.argv[1:]
if 'version' in args:
    print('v2'); sys.exit(0)
if 'config' in args:
    print('{"services": {"web": {"ports": [{"host_ip": "127.0.0.1", "target": 8080, "published": "8088"}]}}}'); sys.exit(0)
if 'inspect' in args:
    print('ghcr.io/example/prizecheck-api:' + os.environ['FAKE_COMMIT']); sys.exit(0)
if 'ps' in args and '-q' in args:
    print('container'); sys.exit(0)
if 'exec' in args and 'printenv' in args:
    print(os.environ.get('FAKE_AUTH_MODE', '')); sys.exit(0)
if 'exec' in args and 'web' in args:
    sys.stdout.write(open(os.environ['FAKE_INDEX']).read()); sys.exit(0)
if 'run' in args and 'tools' in args:
    if any(a.endswith('rule_rollout.py') for a in args):
        with open(os.environ['FAKE_LOG'], 'a') as log:
            log.write(json.dumps({'tools': args, 'tag': os.environ.get('PRIZECHECK_IMAGE_TAG')}) + '\n')
        sys.exit(int(os.environ.get('FAKE_RESTORE_EXIT', '0')))
    if '-c' in args and os.environ.get('FAKE_NO_ROLLOUT_SCRIPT'):  # the probe for scripts/rule_rollout.py in the image
        sys.exit(int(os.environ['FAKE_NO_ROLLOUT_SCRIPT']))
    print('schema'); sys.exit(0)
if 'run' in args and 'auth' in args:
    # The candidate proof is the directory mounted with -v, named by the SIGNUP_READINESS_FILE given with -e.
    mount = args[args.index('-v') + 1].split(':')
    wanted = [a for a in args if a.startswith('SIGNUP_READINESS_FILE=')][0].split('=', 1)[1]
    proof = os.path.join(mount[0], os.path.basename(wanted))
    js = args[args.index('-e', args.index('auth')) + 1].replace('/app/auth/signup.js', os.environ['FAKE_SIGNUP_MODULE'])
    keys = ('EMAIL_SIGN_IN', 'MAIL_MODE', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET')
    settings = {}
    for line in open(os.environ['FAKE_ENV_FILE']).read().splitlines():
        if '=' in line and not line.startswith('#'):
            key, value = line.split('=', 1)
            if key in keys:
                settings[key] = value
    # Like the container, these come only from the env file: scripts/ci.sh exports fake provider credentials.
    inherited = {key: value for key, value in os.environ.items() if key not in keys}
    env = dict(inherited, **settings, SIGNUP_MODE=os.environ['PRIZECHECK_SIGNUP_MODE'], RELEASE_COMMIT=os.environ['PRIZECHECK_IMAGE_TAG'],
               SIGNUP_READINESS_FILE=proof, NODE_ENV='production')
    with open(os.environ['FAKE_LOG'], 'a') as log:
        log.write(json.dumps({'check': True, 'mode': os.environ['PRIZECHECK_SIGNUP_MODE'], 'mount': mount[0]}) + '\n')
    if os.environ.get('FAKE_RUN_EXIT'):
        sys.exit(int(os.environ['FAKE_RUN_EXIT']))
    with tempfile.TemporaryDirectory() as scratch:
        script = os.path.join(scratch, 'check.mjs')
        open(script, 'w').write(js)
        sys.exit(subprocess.run([os.environ['FAKE_TSX'], script], env=env).returncode)
with open(os.environ['FAKE_LOG'], 'a') as log:
    snapshots = sorted(os.listdir(os.environ['FAKE_SNAPSHOTS'])) if os.environ.get('FAKE_SNAPSHOTS') else None
    log.write(json.dumps({'args': args, 'mode': os.environ.get('PRIZECHECK_SIGNUP_MODE'), 'snapshots': snapshots,
                          'tag': os.environ.get('PRIZECHECK_IMAGE_TAG')}) + '\n')
'''.replace('#!PYTHON', '#!' + sys.executable)
# Smoke only needs plausible answers from the web port.
FAKE_CURL = '''#!/bin/sh
case " $* " in
  *" -w "*) case "$*" in *locations*) printf 401;; *unknown-smoke-token*) printf 404;; *) printf 200;; esac;;
  *) cat "$FAKE_INDEX";;
esac
'''
# The script requires root-owned proof files; the tests' files belong to whoever runs them, so `stat` reports uid
# $FAKE_OWNER (default 0) for owners and otherwise defers to the real one.
FAKE_STAT = '''#!/bin/sh
for arg in "$@"; do case "$arg" in *%u*) echo "${FAKE_OWNER:-0}"; exit 0;; esac; done
exec REALSTAT "$@"
'''
# No GNU sha256sum on a Mac.
FAKE_SHA256SUM = ('#!' + sys.executable + '\nimport hashlib, sys\n'
                  'print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest() + "  -")\n')
RELAY = ['MAIL_RELAY_URL=https://relay.example/send', 'MAIL_RELAY_TOKEN=token', 'MAIL_FROM=sender@example.com']


def tee_keeps_writing():
    """The forced-command gate logs through `tee -p`, which BSD tee on a Mac lacks."""
    try:
        return subprocess.run(['tee', '-p', os.devnull], input='', capture_output=True, text=True, timeout=10).returncode == 0
    except OSError:
        return False


def without(lines, *keys):
    return [line for line in lines if line.split('=')[0] not in keys]


class HostDeployScriptTest(unittest.TestCase):
    def make_home(self, lines, mode=0o600):
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        home = Path(scratch.name)
        (home / 'bin').mkdir()
        for name in ('compose.deploy.yml', 'compose.prod.yml'):
            (home / name).write_bytes((ROOT / name).read_bytes())
        (home / 'bin/prizecheck-deploy.sh').write_bytes(SCRIPT.read_bytes())
        for sub in ('postgres', 'public', 'price-runners', 'mail', 'art'):
            (home / 'data' / sub).mkdir(parents=True)
        env = home / 'prizecheck.env'
        env.write_text('\n'.join([*lines, f'PRIZECHECK_DATA_DIR={home / "data"}']) + '\n')
        env.chmod(mode)
        return home

    def run_script(self, home, command='check-config', **extra):
        return subprocess.run(['bash', str(home / 'bin/prizecheck-deploy.sh'), command], capture_output=True, text=True,
                              timeout=30, env={**os.environ, 'HOME': str(home), **extra})

    def check(self, lines, mode=0o600):
        result = self.run_script(self.make_home(lines, mode))
        return result.returncode, result.stdout + result.stderr

    def assertRefused(self, lines, key, mode=0o600):
        code, output = self.check(lines, mode)
        self.assertNotEqual(code, 0, output)
        self.assertIn(key, output)

    def test_a_missing_art_directory_is_refused(self):
        home = self.make_home(PROD)
        (home / 'data/art').rmdir()
        result = self.run_script(home)
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(str(home / 'data/art'), result.stdout + result.stderr)

    def test_a_complete_production_file_passes(self):
        code, output = self.check(PROD)
        self.assertEqual(code, 0, output)
        self.assertIn('Configuration OK (prod)', output)
        # With OAuth sign-in and email off, nothing is mailed, so a missing relay is not worth a warning.
        self.assertNotIn(WARNING, output)

    def test_production_refuses_file_or_console_mail(self):
        for mode in ('file', 'console'):
            self.assertRefused([*without(PROD, 'MAIL_MODE'), f'MAIL_MODE={mode}'], 'MAIL_MODE')

    def test_production_needs_a_sign_in_method(self):
        self.assertRefused(without(PROD, 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'), 'No sign-in method')
        code, output = self.check([*without(PROD, 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'), 'DISCORD_CLIENT_ID=d',
                                   'DISCORD_CLIENT_SECRET=s'])
        self.assertEqual(code, 0, output)

    def test_production_refuses_a_half_configured_provider(self):
        self.assertRefused(without(PROD, 'GOOGLE_CLIENT_SECRET'), 'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET')
        self.assertRefused([*PROD, 'DISCORD_CLIENT_SECRET=s'], 'DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET')

    def test_email_sign_in_in_production_needs_an_https_relay(self):
        email = [*without(PROD, 'EMAIL_SIGN_IN', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'), 'EMAIL_SIGN_IN=on']
        self.assertRefused(email, 'EMAIL_SIGN_IN=on needs MAIL_RELAY_URL')
        self.assertRefused([*email, 'MAIL_RELAY_URL=http://relay.example/send', *RELAY[1:]], 'MAIL_RELAY_URL')
        code, output = self.check([*email, *RELAY])
        self.assertEqual(code, 0, output)
        self.assertIn('Configuration OK (prod)', output)
        self.assertNotIn(WARNING, output)

    def test_production_needs_an_https_origin_without_a_path(self):
        for origin in ('http://prizecheck.example.com', 'https://prizecheck.example.com/app', 'prizecheck.example.com'):
            self.assertRefused([*without(PROD, 'PUBLIC_ORIGIN'), f'PUBLIC_ORIGIN={origin}'], 'PUBLIC_ORIGIN')

    def test_production_refuses_relay_credentials_and_a_bad_signup_cap(self):
        self.assertRefused([*PROD, 'MAIL_RELAY_URL=https://u:p@relay.example/send', *RELAY[1:]], 'MAIL_RELAY_URL')
        self.assertRefused([*PROD, 'DAILY_SIGNUP_CAP=ten'], 'DAILY_SIGNUP_CAP')

    def test_production_web_stays_on_loopback(self):
        self.assertRefused([*PROD, 'PRIZECHECK_WEB_BIND=0.0.0.0'], 'PRIZECHECK_WEB_BIND')

    def test_production_needs_its_own_project(self):
        self.assertRefused(without(PROD, 'PRIZECHECK_PROJECT'), 'PRIZECHECK_PROJECT')
        self.assertRefused([*without(PROD, 'PRIZECHECK_PROJECT'), 'PRIZECHECK_PROJECT=prizecheck-dev'], 'PRIZECHECK_PROJECT')

    def test_an_unknown_environment_is_refused(self):
        self.assertRefused([*without(PROD, 'PRIZECHECK_ENVIRONMENT'), 'PRIZECHECK_ENVIRONMENT=staging'],
                           'PRIZECHECK_ENVIRONMENT must be dev or prod')

    def test_the_env_file_must_be_private(self):
        self.assertRefused(PROD, 'must be mode 600', mode=0o644)

    def test_lines_compose_reads_but_the_checks_do_not_are_refused(self):
        for line in ('export PRIZECHECK_WEB_BIND=0.0.0.0', '  PRIZECHECK_WEB_BIND=0.0.0.0', 'PRIZECHECK_WEB_BIND: 0.0.0.0'):
            lines = [*PROD, line]
            code, output = self.check(lines)
            self.assertNotEqual(code, 0, line)
            self.assertIn(f'line {len(lines)} must be KEY=value', output)
            self.assertNotIn('0.0.0.0', output)
        # A quoted value that runs on swallows the next line in Compose, which then renders the first bind address.
        for opening in ('X="', "X='"):
            lines = [*PROD, 'PRIZECHECK_WEB_BIND=0.0.0.0', opening, 'PRIZECHECK_WEB_BIND=127.0.0.1"']
            code, output = self.check(lines)
            self.assertNotEqual(code, 0, opening)
            self.assertIn('quoted value that does not close', output)
        # Compose skips spaces after the `=` and lets a backslash escape the closing quote: each of these makes it read
        # MAIL_MODE=file where the checks read MAIL_MODE=http.
        mail = without(PROD, 'MAIL_MODE')
        for hidden in (['MAIL_MODE=file', 'X= "', 'MAIL_MODE=http', 'Y=a"'],
                       ['MAIL_MODE=file', 'X="a\\"', 'MAIL_MODE=http', 'Y=" # c"'],
                       ['MAIL_MODE=file', "X='a\\'", 'MAIL_MODE=http', "Y=' # c'"],
                       ["MAIL_MODE=file", "X= '", 'MAIL_MODE=http', "Y=a'"]):
            code, output = self.check([*mail, *hidden])
            self.assertNotEqual(code, 0, hidden)
            self.assertRegex(output, r'line \d+ has (a space|a backslash|a quoted value)')
        for opening in ('K="a\\"b"', "K='a\\'b'"):
            code, output = self.check([*PROD, opening])
            self.assertNotEqual(code, 0, opening)
            self.assertIn('backslash inside a quoted value', output)
        # An empty quoted value with trailing space is an empty value, as in Compose.
        code, output = self.check([*without(PROD, 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'), 'DISCORD_CLIENT_ID="" ',
                                   'DISCORD_CLIENT_SECRET=""', 'GOOGLE_CLIENT_ID=g', 'GOOGLE_CLIENT_SECRET=s'])
        self.assertEqual(code, 0, output)
        self.assertNotIn('must be set together', output)
        code, output = self.check([*PROD, 'X="a b" # note', "Y='c'"])
        self.assertEqual(code, 0, output)
        code, output = self.check(['# a comment', '', '   # an indented comment', *PROD])
        self.assertEqual(code, 0, output)

    def fake_docker(self, *host_ips):
        """A `docker` that answers `compose version` and prints a rendered model with one published port per entry
        (None publishes it without a host_ip)."""
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        model = Path(scratch.name) / 'model.json'
        ports = ', '.join(('{"host_ip": "%s", ' % ip if ip else '{') + '"target": 8080, "published": "%d"}' % (8088 + i)
                          for i, ip in enumerate(host_ips))
        model.write_text('{"services": {"web": {"ports": [%s]}}}\n' % ports)
        docker = Path(scratch.name) / 'docker'
        docker.write_text('#!/bin/sh\ncase " $* " in *" version "*) echo v2; exit 0;; esac\ncat "$FAKE_MODEL"\n')
        docker.chmod(docker.stat().st_mode | stat.S_IXUSR)
        return {'PATH': f'{scratch.name}:{os.environ["PATH"]}', 'FAKE_MODEL': str(model)}

    def test_production_asserts_the_rendered_web_port_is_on_loopback(self):
        result = self.run_script(self.make_home(PROD), **self.fake_docker('0.0.0.0'))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('published on 127.0.0.1 only', result.stdout + result.stderr)
        result = self.run_script(self.make_home(PROD), **self.fake_docker('127.0.0.1'))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        # A second published port without a host_ip binds every interface.
        result = self.run_script(self.make_home(PROD), **self.fake_docker('127.0.0.1', None))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('published on 127.0.0.1 only', result.stdout + result.stderr)

    def test_dev_compares_the_rendered_port_with_the_checked_bind(self):
        result = self.run_script(self.make_home(DEV), **self.fake_docker('0.0.0.0'))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('published on 127.0.0.1 only', result.stdout + result.stderr)
        result = self.run_script(self.make_home(DEV), **self.fake_docker('127.0.0.1'))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_the_signup_mode_in_the_env_file(self):
        for mode in ('owner-only', 'public', ''):
            code, output = self.check([*PROD, f'SIGNUP_MODE={mode}'])
            self.assertEqual(code, 0 if mode != 'public' else 1, output)
        for mode in ('local-public', 'open', 'Public'):
            self.assertRefused([*PROD, f'SIGNUP_MODE={mode}'], 'SIGNUP_MODE must be owner-only or public')
        self.assertRefused([*PROD, 'PRIZECHECK_SIGNUP_MODE=public'], 'PRIZECHECK_SIGNUP_MODE is computed by the deploy script')
        self.assertRefused([*DEV, 'PRIZECHECK_SIGNUP_MODE=owner-only'], 'PRIZECHECK_SIGNUP_MODE')
        self.assertRefused([*DEV, 'SIGNUP_MODE=public'], 'SIGNUP_MODE=public is for production only')
        code, output = self.check([*DEV, 'SIGNUP_MODE=owner-only'])
        self.assertEqual(code, 0, output)

    def write_proof(self, home, proof=PROOF, mode=0o644, directory_mode=0o755):
        directory = home / 'signup'
        directory.mkdir(exist_ok=True)
        directory.chmod(directory_mode)
        file = directory / 'readiness.json'
        file.write_text(json.dumps(proof))
        file.chmod(mode)
        return file

    def fake_env(self, home, **extra):
        """Environment that puts the fake docker, curl, flock, sleep, stat and sha256sum first on PATH."""
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        bin_dir = Path(scratch.name)
        shims = {'docker': FAKE_DOCKER, 'curl': FAKE_CURL, 'flock': '#!/bin/sh\nexit 0\n', 'sleep': '#!/bin/sh\nexit 0\n',
                 'stat': FAKE_STAT.replace('REALSTAT', shutil.which('stat')), 'sha256sum': FAKE_SHA256SUM}
        for name, body in shims.items():
            (bin_dir / name).write_text(body)
            (bin_dir / name).chmod(0o755)
        index = bin_dir / 'index.html'
        index.write_text('<script src="/assets/app.js"></script>\n')
        self.fake_log = bin_dir / 'calls.jsonl'
        return {'PATH': f'{bin_dir}:{os.environ["PATH"]}', 'FAKE_COMMIT': COMMIT, 'FAKE_INDEX': str(index),
                'FAKE_LOG': str(self.fake_log), 'FAKE_ENV_FILE': str(home / 'prizecheck.env'),
                'FAKE_SIGNUP_MODULE': str(ROOT / 'auth/src/signup.ts'), 'FAKE_TSX': str(TSX), **extra}

    def fake_calls(self):
        return [json.loads(line) for line in self.fake_log.read_text().splitlines()] if self.fake_log.exists() else []

    def test_check_config_inspects_the_proof_file_when_signup_is_public(self):
        public = [*PROD, 'SIGNUP_MODE=public']

        def run(home, **extra):
            result = self.run_script(home, **self.fake_env(home, **extra))
            return result.returncode, result.stdout + result.stderr

        home = self.make_home(public)
        code, output = run(home)
        self.assertNotEqual(code, 0)
        self.assertIn('readiness proof', output)
        self.assertIn('is missing', output)
        for kwargs, message in (({'mode': 0o664}, 'group or world writable'), ({'directory_mode': 0o777}, 'group or world writable')):
            home = self.make_home(public)
            self.write_proof(home, **kwargs)
            code, output = run(home)
            self.assertNotEqual(code, 0, kwargs)
            self.assertIn(message, output)
        # The gateway reads only the script's own copy, so the operator's file and directory may be private.
        home = self.make_home(public)
        self.write_proof(home, mode=0o600, directory_mode=0o700)
        code, output = run(home)
        self.assertEqual(code, 0, output)
        # Production wants root: a file that belongs to the invoking user is not enough.
        home = self.make_home(public)
        self.write_proof(home)
        code, output = run(home, FAKE_OWNER='1000')
        self.assertNotEqual(code, 0)
        self.assertIn('must be owned by root', output)
        home = self.make_home(public)
        self.write_proof(home)
        code, output = run(home)
        self.assertEqual(code, 0, output)
        self.assertNotIn('Warning', output)
        # A proof for another commit is a warning: that release runs owner-only, and the next one cannot carry.
        (home / 'state').mkdir()
        (home / 'state/current').write_text(OTHER + '\n')
        code, output = run(home)
        self.assertEqual(code, 0, output)
        self.assertIn(f'Warning: the readiness proof does not name the current release {OTHER}', output)
        # A symlinked proof is refused.
        home = self.make_home(public)
        self.write_proof(home)
        real = home / 'elsewhere.json'
        (home / 'signup/readiness.json').rename(real)
        (home / 'signup/readiness.json').symlink_to(real)
        code, output = run(home)
        self.assertNotEqual(code, 0)
        self.assertIn('must not be a symlink', output)

    def signup_home(self, lines, proof=PROOF, **proof_kwargs):
        """A home whose current release is COMMIT, with the operator's proof written (or absent when None)."""
        home = self.make_home(lines)
        (home / 'state').mkdir()
        (home / 'state/current').write_text(COMMIT + '\n')
        if proof is not None:
            self.write_proof(home, proof, **proof_kwargs)
        return home

    def apply(self, home, **extra):
        """Runs `signup-apply`; returns (exit code, output, recorded docker calls)."""
        result = subprocess.run(['bash', str(home / 'bin/prizecheck-deploy.sh'), 'signup-apply'], capture_output=True, text=True,
                                timeout=60, stdin=subprocess.DEVNULL,
                                env={**os.environ, 'HOME': str(home), **self.fake_env(home, **extra)})
        return result.returncode, result.stdout + result.stderr, self.fake_calls()

    def assertAllModes(self, calls, expected):
        """Every Compose call that is not the readiness check carries an explicit mode, and the up calls the result."""
        up = [call for call in calls if 'args' in call and 'up' in call['args']]
        self.assertTrue(up)
        for call in calls:
            if 'compose' in call.get('args', [])[:1]:
                self.assertIn(call['mode'], ('owner-only', 'public'), call)
        self.assertTrue(all(call['mode'] == expected for call in up), up)

    def assertSignup(self, lines, expected, reason=None, **kwargs):
        home = self.signup_home(lines, **kwargs)
        code, output, calls = self.apply(home)
        self.assertEqual(code, 0, output)
        self.assertIn(f'Signup mode for release {COMMIT}: {expected}', output)
        if reason:
            self.assertIn(reason, output)
        self.assertAllModes(calls, expected)
        self.assertNotIn(SECRET, output)
        self.assertEqual((home / f'signup-active/{COMMIT}.json').exists(), expected == 'public')
        return output

    @unittest.skipUnless(TSX.exists() and shutil.which('node'), 'needs node and tsx (npm ci)')
    def test_signup_apply_opens_signup_only_on_a_valid_proof_for_the_release(self):
        public = [*PROD, 'SIGNUP_MODE=public']
        output = self.assertSignup(public, 'public')
        self.assertIn(f'Signup: public for release {COMMIT}', output)
        # Without a request, or with the default, the proof is not even consulted.
        for lines in (PROD, [*PROD, 'SIGNUP_MODE=owner-only'], [*PROD, 'SIGNUP_MODE=']):
            code, output, calls = self.apply(self.signup_home(lines))
            self.assertEqual(code, 0, output)
            self.assertFalse([call for call in calls if call.get('check')])
            self.assertIn(f'Signup mode for release {COMMIT}: owner-only', output)
        self.assertSignup(public, 'owner-only', f'readiness proof names commit {OTHER}, not {COMMIT}',
                          proof={**PROOF, 'releaseCommit': OTHER})
        self.assertSignup(public, 'owner-only', 'Signup readiness incomplete', proof={**PROOF, 'recoveryVerified': False})
        self.assertSignup(public, 'owner-only', 'Signup readiness incomplete', proof={**PROOF, 'schemaVersion': 1})
        self.assertSignup(public, 'owner-only', 'Signup readiness incomplete', proof={**PROOF, 'evidence': ' '})
        # Google is configured but not proven.
        self.assertSignup(public, 'owner-only', 'Signup readiness incomplete', proof={**PROOF, 'providerSignInVerified': []})
        self.assertSignup(public, 'owner-only', 'is missing', proof=None)
        # A private operator file is fine: the published copy is what the gateway reads.
        self.assertSignup(public, 'public', mode=0o600, directory_mode=0o700)

    @unittest.skipUnless(TSX.exists() and shutil.which('node'), 'needs node and tsx (npm ci)')
    def test_a_failed_publish_never_reports_public(self):
        home = self.signup_home([*PROD, 'SIGNUP_MODE=public'])
        (home / f'signup-active/{COMMIT}.json').mkdir(parents=True)
        code, output, calls = self.apply(home)
        self.assertEqual(code, 0, output)
        self.assertIn('cannot publish the validated proof', output)
        self.assertIn(f'Signup mode for release {COMMIT}: owner-only', output)
        self.assertAllModes(calls, 'owner-only')
        self.assertEqual(list((home / 'signup-active').iterdir()), [])
        self.assertEqual([path.name for path in home.glob('.signup-stage.*')], [])

    @unittest.skipUnless(TSX.exists() and shutil.which('node'), 'needs node and tsx (npm ci)')
    def test_signup_apply_checks_the_mail_gates_when_email_sign_in_is_on(self):
        email = [*without(PROD, 'EMAIL_SIGN_IN'), 'EMAIL_SIGN_IN=on', *RELAY, 'SIGNUP_MODE=public']
        self.assertSignup(email, 'owner-only', 'Signup readiness incomplete')
        self.assertSignup(email, 'public', proof={**PROOF, 'senderVerified': True, 'recipientDeliveryVerified': True})

    @unittest.skipUnless(TSX.exists() and shutil.which('node'), 'needs node and tsx (npm ci)')
    def test_a_check_that_cannot_run_leaves_the_release_owner_only(self):
        # `docker compose run` failing (no image, daemon trouble) or timing out must not stop the release.
        for status in ('125', '124'):
            home = self.signup_home([*PROD, 'SIGNUP_MODE=public'])
            code, output, calls = self.apply(home, FAKE_RUN_EXIT=status)
            self.assertEqual(code, 0, output)
            self.assertIn('could not run', output)
            self.assertIn(f'Signup mode for release {COMMIT}: owner-only', output)
            self.assertAllModes(calls, 'owner-only')
            self.assertFalse(list((home / 'signup-active').glob('*.json')))

    @unittest.skipUnless(TSX.exists() and shutil.which('node'), 'needs node and tsx (npm ci)')
    def test_a_deploy_of_another_release_runs_owner_only_and_succeeds(self):
        home = self.signup_home([*PROD, 'SIGNUP_MODE=public'])
        code, output = self.deploy(home, OTHER)
        self.assertEqual(code, 0, output)
        self.assertIn(f'Deployed {OTHER}', output)
        self.assertIn(f'readiness proof names commit {COMMIT}, not {OTHER}', output)
        self.assertAllModes(self.fake_calls(), 'owner-only')
        self.assertFalse(list((home / 'signup-active').glob('*.json')))

    def deploy(self, home, commit, **extra):
        digest = hashlib.sha256(b''.join((home / name).read_bytes()
                                         for name in ('compose.deploy.yml', 'compose.prod.yml', 'bin/prizecheck-deploy.sh'))).hexdigest()
        for path in ('current.json', 'records/current.json'):
            (home / 'data/public' / path).parent.mkdir(parents=True, exist_ok=True)
            (home / 'data/public' / path).write_text('{}')
        result = subprocess.run(['bash', str(home / 'bin/prizecheck-deploy.sh'), 'deploy', commit, digest], capture_output=True,
                                text=True, timeout=60, stdin=subprocess.DEVNULL,
                                env={**os.environ, 'HOME': str(home), **self.fake_env(home, **{'FAKE_COMMIT': commit, **extra})})
        return result.returncode, result.stdout + result.stderr

    def carry_home(self, extra=(), proof=PROOF, snapshot=True):
        """A public home whose running release COMMIT has its published proof (unless snapshot is False)."""
        home = self.signup_home([*PROD, 'SIGNUP_MODE=public', *extra], proof=proof, mode=0o600)
        if snapshot:
            (home / 'signup-active').mkdir()
            (home / f'signup-active/{COMMIT}.json').write_text(json.dumps(PROOF))
        return home

    def assertCarried(self, home, commit, output):
        self.assertIn(f'Signup: public for release {commit} (readiness proof carried forward from', output)
        gateway = [call for call in self.fake_calls() if 'up' in call.get('args', []) and 'auth' in call['args']]
        self.assertTrue(gateway and all(call['mode'] == 'public' for call in gateway), gateway)
        self.assertEqual([path.name for path in (home / 'signup-active').iterdir()], [f'{commit}.json'])
        proof = home / 'signup/readiness.json'
        self.assertEqual(json.loads(proof.read_text()), {**PROOF, 'releaseCommit': commit})
        self.assertEqual(stat.S_IMODE(proof.stat().st_mode), 0o600)
        self.assertEqual([path.name for path in (home / 'signup').iterdir()], ['readiness.json'])

    def assertNotCarried(self, home, output, proof=PROOF):
        self.assertNotIn('carried forward from', output)
        self.assertEqual(json.loads((home / 'signup/readiness.json').read_text()), proof)
        gateway = [call for call in self.fake_calls() if 'up' in call.get('args', []) and 'auth' in call['args']]
        self.assertTrue(gateway and all(call['mode'] == 'owner-only' for call in gateway), gateway)
        self.assertFalse(list((home / 'signup-active').glob('*.json')))

    @unittest.skipUnless(TSX.exists() and shutil.which('node'), 'needs node and tsx (npm ci)')
    def test_a_deploy_while_the_running_release_is_public_carries_signup_forward(self):
        home = self.carry_home()
        code, output = self.deploy(home, OTHER)
        self.assertEqual(code, 0, output)
        self.assertIn(f'readiness proof carried forward from {COMMIT}', output)
        self.assertCarried(home, OTHER, output)
        self.assertEqual((home / 'state/current').read_text().strip(), OTHER)
        # The next release carries again from the updated file.
        code, output = self.deploy(home, COMMIT)
        self.assertEqual(code, 0, output)
        self.assertCarried(home, COMMIT, output)

    @unittest.skipUnless(TSX.exists() and shutil.which('node'), 'needs node and tsx (npm ci)')
    def test_a_pretty_printed_proof_carries_too(self):
        home = self.carry_home()
        (home / 'signup/readiness.json').write_text(json.dumps(PROOF, indent=2))
        code, output = self.deploy(home, OTHER)
        self.assertEqual(code, 0, output)
        self.assertCarried(home, OTHER, output)

    @unittest.skipUnless(TSX.exists() and shutil.which('node'), 'needs node and tsx (npm ci)')
    def test_a_rollback_carries_signup_forward_too(self):
        home = self.carry_home()
        (home / 'state/previous').write_text(OTHER + '\n')
        result = subprocess.run(['bash', str(home / 'bin/prizecheck-deploy.sh'), 'rollback'], capture_output=True, text=True,
                                timeout=60, stdin=subprocess.DEVNULL,
                                env={**os.environ, 'HOME': str(home), **self.fake_env(home, FAKE_COMMIT=OTHER)})
        output = result.stdout + result.stderr
        self.assertEqual(result.returncode, 0, output)
        self.assertCarried(home, OTHER, output)

    def rollback(self, home, **extra):
        result = subprocess.run(['bash', str(home / 'bin/prizecheck-deploy.sh'), 'rollback'], capture_output=True, text=True,
                                timeout=60, stdin=subprocess.DEVNULL,
                                env={**os.environ, 'HOME': str(home), **self.fake_env(home, **extra)})
        return result.returncode, result.stdout + result.stderr

    def test_a_rollback_restores_rules_with_the_current_release_first(self):
        home = self.signup_home(PROD)
        (home / 'state/previous').write_text(OTHER + '\n')
        code, output = self.rollback(home, FAKE_COMMIT=OTHER)
        self.assertEqual(code, 0, output)
        calls = self.fake_calls()
        [index] = [i for i, call in enumerate(calls) if 'tools' in call]
        self.assertEqual(calls[index]['tag'], COMMIT)  # the current release's tool, so it knows the rules to hand back
        self.assertEqual(calls[index]['tools'][-3:], ['restore', '--to', OTHER])
        stopped = [i for i, call in enumerate(calls) if call.get('args', [])[-2:] == ['stop', 'api']]
        self.assertTrue(stopped and stopped[0] < index, calls)  # the API stops before the restore
        first_up = next(i for i, call in enumerate(calls) if 'up' in call.get('args', []))
        self.assertLess(index, first_up)
        self.assertEqual((home / 'state/current').read_text().strip(), OTHER)

    def test_a_release_that_predates_rule_rollout_has_no_restore_to_run(self):
        home = self.signup_home(PROD)
        (home / 'state/previous').write_text(OTHER + '\n')
        code, output = self.rollback(home, FAKE_COMMIT=OTHER, FAKE_NO_ROLLOUT_SCRIPT='3')
        self.assertEqual(code, 0, output)
        self.assertIn('predates catalog rule rollout', output)
        self.assertFalse([call for call in self.fake_calls() if 'tools' in call])
        self.assertEqual((home / 'state/current').read_text().strip(), OTHER)

    def test_a_probe_that_fails_for_another_reason_refuses_the_rollback(self):
        home = self.signup_home(PROD)
        (home / 'state/previous').write_text(OTHER + '\n')
        code, output = self.rollback(home, FAKE_COMMIT=COMMIT, FAKE_NO_ROLLOUT_SCRIPT='1')
        self.assertEqual(code, 1, output)
        self.assertIn('refused: restoring its catalog rules failed', output)
        self.assertNotIn('predates', output)
        self.assertEqual((home / 'state/current').read_text().strip(), COMMIT)

    def test_a_failed_deploy_hands_back_the_running_releases_rules_with_the_new_releases_tool(self):
        home = self.signup_home(PROD)
        code, output = self.deploy(home, OTHER, FAKE_COMMIT=COMMIT)  # the images report the old tag: smoke fails
        self.assertNotEqual(code, 0, output)
        calls = self.fake_calls()
        [index] = [i for i, call in enumerate(calls) if 'tools' in call]
        self.assertEqual((calls[index]['tag'], calls[index]['tools'][-3:]), (OTHER, ['restore', '--to', COMMIT]))
        stopped = [i for i, call in enumerate(calls[:index]) if call.get('args', [])[-2:] == ['stop', 'api']]
        self.assertTrue(stopped, calls)  # the broken release's API stops first
        ups = [call for call in calls[index:] if 'up' in call.get('args', [])]
        self.assertTrue(ups and all(call['tag'] == COMMIT for call in ups), ups)  # then the running release restarts
        self.assertEqual((home / 'state/current').read_text().strip(), COMMIT)

    def test_a_failed_rules_restore_does_not_stop_a_failed_deploy_from_restarting_the_running_release(self):
        home = self.signup_home(PROD)
        code, output = self.deploy(home, OTHER, FAKE_COMMIT=COMMIT, FAKE_RESTORE_EXIT='2')
        self.assertNotEqual(code, 0, output)
        self.assertIn("WARNING: restoring %s's catalog rules failed" % COMMIT, output)
        self.assertIn(f'Restoring release {COMMIT}', output)

    def test_a_failed_rule_restore_refuses_the_rollback(self):
        home = self.signup_home(PROD)
        (home / 'state/previous').write_text(OTHER + '\n')
        code, output = self.rollback(home, FAKE_COMMIT=COMMIT, FAKE_RESTORE_EXIT='2')
        self.assertEqual(code, 1, output)
        self.assertIn('refused: restoring its catalog rules failed', output)
        self.assertEqual((home / 'state/current').read_text().strip(), COMMIT)
        ups = [call for call in self.fake_calls() if 'up' in call.get('args', [])]
        self.assertTrue(ups and all(call['tag'] == COMMIT for call in ups), ups)  # only the current release was restarted

    @unittest.skipUnless(TSX.exists() and shutil.which('node'), 'needs node and tsx (npm ci)')
    def test_signup_is_not_carried_when_the_operator_closed_it_or_the_running_release_was_not_public(self):
        home = self.signup_home([*PROD, 'SIGNUP_MODE=owner-only'])
        (home / 'signup-active').mkdir()
        (home / f'signup-active/{COMMIT}.json').write_text(json.dumps(PROOF))
        code, output = self.deploy(home, OTHER)
        self.assertEqual(code, 0, output)
        self.assertNotCarried(home, output)
        # The proof names a commit that has no snapshot (it never ran public): no carry.
        home = self.carry_home(snapshot=False)
        code, output = self.deploy(home, OTHER)
        self.assertEqual(code, 0, output)
        self.assertNotCarried(home, output)

    @unittest.skipUnless(TSX.exists() and shutil.which('node'), 'needs node and tsx (npm ci)')
    def test_a_carried_proof_that_fails_validation_leaves_the_release_owner_only(self):
        for bad in ({'recoveryVerified': False}, {'providerSignInVerified': []}, {'authorizedByOwner': False}):
            proof = {**PROOF, **bad}
            home = self.carry_home(proof=proof)
            code, output = self.deploy(home, OTHER)
            self.assertEqual(code, 0, output)
            self.assertIn('carried forward from', output)
            self.assertIn('is refused: Signup readiness incomplete', output)
            self.assertNotIn('public for release', output)
            self.assertNotCarried(home, '', proof)

    @unittest.skipUnless(TSX.exists() and shutil.which('node'), 'needs node and tsx (npm ci)')
    def test_a_failed_deploy_or_rollback_leaves_the_proof_naming_the_running_release(self):
        home = self.carry_home()
        code, output = self.deploy(home, OTHER, FAKE_COMMIT=COMMIT)  # the images report the old tag: smoke fails
        self.assertNotEqual(code, 0, output)
        self.assertRestoredPublic(home, output)
        home = self.carry_home()
        (home / 'state/previous').write_text(OTHER + '\n')
        result = subprocess.run(['bash', str(home / 'bin/prizecheck-deploy.sh'), 'rollback'], capture_output=True, text=True,
                                timeout=60, stdin=subprocess.DEVNULL,
                                env={**os.environ, 'HOME': str(home), **self.fake_env(home, FAKE_COMMIT=COMMIT)})
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertRestoredPublic(home, result.stdout + result.stderr)

    def assertRestoredPublic(self, home, output):
        self.assertIn(f'Restoring release {COMMIT}', output)
        self.assertIn(f'Signup: public for release {COMMIT} (readiness proof valid)', output)
        self.assertEqual(json.loads((home / 'signup/readiness.json').read_text()), PROOF, output)
        self.assertEqual((home / 'state/current').read_text().strip(), COMMIT)
        self.assertEqual([path.name for path in (home / 'signup-active').iterdir()], [f'{COMMIT}.json'])
        gateway = [call for call in self.fake_calls() if 'up' in call.get('args', []) and 'auth' in call['args']]
        self.assertTrue(gateway[-1]['mode'] == 'public', gateway)

    @unittest.skipUnless(TSX.exists() and shutil.which('node'), 'needs node and tsx (npm ci)')
    def test_a_proof_that_cannot_be_rewritten_only_warns(self):
        home = self.carry_home()
        # A read-only directory: the operator's file cannot be replaced.
        (home / 'signup').chmod(0o555)
        self.addCleanup((home / 'signup').chmod, 0o755)
        code, output = self.deploy(home, OTHER)
        self.assertEqual(code, 0, output)
        self.assertIn('could not update', output)
        self.assertIn('will not carry signup forward', output)
        self.assertEqual(json.loads((home / 'signup/readiness.json').read_text()), PROOF)

    @unittest.skipUnless(TSX.exists() and shutil.which('node'), 'needs node and tsx (npm ci)')
    def test_the_running_releases_proof_stays_until_the_new_gateway_is_up(self):
        home = self.signup_home([*PROD, 'SIGNUP_MODE=public'], proof={**PROOF, 'releaseCommit': OTHER})
        active = home / 'signup-active'
        active.mkdir()
        (active / f'{COMMIT}.json').write_text(json.dumps(PROOF))
        code, output = self.deploy(home, OTHER, FAKE_SNAPSHOTS=str(active))
        self.assertEqual(code, 0, output)
        self.assertIn(f'Signup: public for release {OTHER}', output)
        # While the services start, the old release's file is still there beside the new one...
        ups = [call for call in self.fake_calls() if 'up' in call.get('args', []) and 'auth' in call['args']]
        self.assertEqual(ups[-1]['snapshots'], [f'{COMMIT}.json', f'{OTHER}.json'])
        self.assertEqual(ups[-1]['mode'], 'public')
        # ...and afterwards only the running release's remains.
        self.assertEqual([path.name for path in active.iterdir()], [f'{OTHER}.json'])

    @unittest.skipUnless(TSX.exists() and shutil.which('node'), 'needs node and tsx (npm ci)')
    def test_the_gateway_reads_a_validated_snapshot_not_the_operators_file(self):
        home = self.signup_home([*PROD, 'SIGNUP_MODE=public'])
        snapshot = home / f'signup-active/{COMMIT}.json'
        code, output, calls = self.apply(home)
        self.assertEqual(code, 0, output)
        self.assertEqual(json.loads(snapshot.read_text()), PROOF)
        # The check ran on a staged copy of the operator's file, never on the snapshot directory.
        checks = [call for call in calls if call.get('check')]
        self.assertTrue(checks)
        self.assertTrue(all(Path(call['mount']).parent.resolve() == home.resolve() and Path(call['mount']).name.startswith('.signup-stage.')
                            for call in checks), checks)
        self.assertEqual([path.name for path in home.glob('.signup-stage.*')], [])
        self.assertEqual(stat.S_IMODE(snapshot.stat().st_mode), 0o644)
        # Editing the operator's file changes nothing until signup-apply: the snapshot is what a restart would read.
        (home / 'signup/readiness.json').write_text(json.dumps({**PROOF, 'recoveryVerified': False}))
        self.assertEqual(json.loads(snapshot.read_text()), PROOF)
        # Applying an unchanged request with the gateway already public restarts nothing...
        code, output, calls = self.apply(home, FAKE_AUTH_MODE='public')
        self.assertEqual(code, 0, output)
        self.assertIn('Signup mode for release %s: owner-only' % COMMIT, output)
        self.assertFalse(snapshot.exists())
        # ...while the edited (now invalid) proof closes signup, which needs the restart.
        self.assertTrue([call for call in calls if '--force-recreate' in call.get('args', [])])

    @unittest.skipUnless(TSX.exists() and shutil.which('node'), 'needs node and tsx (npm ci)')
    def test_signup_apply_skips_the_restart_when_nothing_changed(self):
        home = self.signup_home([*PROD, 'SIGNUP_MODE=public'])
        code, output, calls = self.apply(home, FAKE_AUTH_MODE='')
        self.assertEqual(code, 0, output)
        self.assertIn('/api is unavailable', output)
        self.assertTrue([call for call in calls if '--force-recreate' in call.get('args', [])])
        self.fake_log.unlink()
        code, output, calls = self.apply(home, FAKE_AUTH_MODE='public')
        self.assertEqual(code, 0, output)
        self.assertIn('not restarting it', output)
        self.assertFalse([call for call in calls if '--force-recreate' in call.get('args', [])])
        # A changed proof restarts the gateway even though the mode is the same.
        (home / 'signup/readiness.json').write_text(json.dumps({**PROOF, 'evidence': 'newer notes'}))
        self.fake_log.unlink()
        code, output, calls = self.apply(home, FAKE_AUTH_MODE='public')
        self.assertEqual(code, 0, output)
        self.assertTrue([call for call in calls if '--force-recreate' in call.get('args', [])])

    @unittest.skipUnless(TSX.exists() and shutil.which('node'), 'needs node and tsx (npm ci)')
    def test_status_reports_the_signup_mode(self):
        home = self.make_home([*PROD, 'SIGNUP_MODE=public'])
        result = subprocess.run(['bash', str(home / 'bin/prizecheck-deploy.sh'), 'status'], capture_output=True, text=True,
                                timeout=60, stdin=subprocess.DEVNULL,
                                env={**os.environ, 'HOME': str(home), **self.fake_env(home, FAKE_AUTH_MODE='owner-only')})
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('signup:   public requested, gateway running owner-only', result.stdout)

    @unittest.skipUnless(tee_keeps_writing(), 'the SSH gate logs through GNU tee -p')
    def test_the_ssh_gate_refuses_operator_commands(self):
        for command in ('check-config', 'bundle-digest', 'setup'):
            result = self.run_script(self.make_home(PROD), '--ssh-gate', SSH_ORIGINAL_COMMAND=command)
            output = result.stdout + result.stderr
            self.assertNotEqual(result.returncode, 0, command)
            self.assertIn('Refused', output)
            self.assertNotRegex(output, r'[0-9a-f]{64}|Configuration OK')

    def test_a_dev_file_without_the_environment_key_still_passes(self):
        code, output = self.check(DEV)
        self.assertEqual(code, 0, output)
        self.assertIn('Configuration OK (dev)', output)

    def test_the_bundle_digest_covers_the_overlay_only_in_production(self):
        script = SCRIPT.read_bytes()
        deploy = (ROOT / 'compose.deploy.yml').read_bytes()
        overlay = (ROOT / 'compose.prod.yml').read_bytes()
        dev = self.run_script(self.make_home(DEV), 'bundle-digest')
        prod = self.run_script(self.make_home(PROD), 'bundle-digest')
        self.assertEqual(dev.returncode, 0, dev.stderr)
        self.assertEqual(prod.returncode, 0, prod.stderr)
        self.assertEqual(dev.stdout.split()[-1], hashlib.sha256(deploy + script).hexdigest())
        self.assertEqual(prod.stdout.split()[-1], hashlib.sha256(deploy + overlay + script).hexdigest())


if __name__ == '__main__':
    unittest.main()
