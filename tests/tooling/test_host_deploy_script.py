"""The host script's configuration checks (deploy/host/prizecheck-deploy.sh): `check-config` and `bundle-digest` run
against a scratch PRIZECHECK_HOME. Docker is absent or faked (the published-port check reads Compose's rendered model). Production refuses what the auth gateway would reject under
NODE_ENV=production, or what would expose the web port; a dev file keeps passing as it did. Each case checks the exit code
and a stable substring of the message (which names a key, never a value)."""
import hashlib
from pathlib import Path
import os
import subprocess
import stat
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
        for sub in ('postgres', 'public', 'price-runners', 'mail'):
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

    def test_a_complete_production_file_passes(self):
        code, output = self.check(PROD)
        self.assertEqual(code, 0, output)
        self.assertIn('Configuration OK (prod)', output)
        self.assertIn(WARNING, output)

    def test_the_no_relay_warning_goes_to_stderr(self):
        result = self.run_script(self.make_home(PROD))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(WARNING, result.stderr)
        self.assertNotIn(WARNING, result.stdout)

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
