"""The host script's configuration checks (deploy/host/prizecheck-deploy.sh): `check-config` and `bundle-digest` run
against a scratch PRIZECHECK_HOME, with no Docker. Production refuses what the auth gateway would reject under
NODE_ENV=production, or what would expose the web port; a dev file keeps passing as it did. Each case checks the exit code
and a stable substring of the message (which names a key, never a value)."""
import hashlib
from pathlib import Path
import os
import subprocess
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

    def run_script(self, home, command='check-config'):
        return subprocess.run(['bash', str(home / 'bin/prizecheck-deploy.sh'), command], capture_output=True, text=True,
                              timeout=30, env={**os.environ, 'HOME': str(home)})

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
