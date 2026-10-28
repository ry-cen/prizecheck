"""The deployment pipeline's wiring (spec: docs/deployment-oracle.md, docs/deployment-unraid.md): dev builds each
architecture natively and joins them, production deploys only dev's images and never builds, and the addresses that make
up the client-IP chain (compose.prod.yml, deploy/docker/nginx.conf, deploy/oracle/Caddyfile) agree. Text and regex only:
no YAML library is available to the tooling tests."""
import ipaddress
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[2]
DEV = (ROOT / '.github/workflows/deploy-dev.yml').read_text()
PROD = (ROOT / '.github/workflows/deploy-prod.yml').read_text()
VERIFY = (ROOT / '.github/workflows/verify.yml').read_text()
SCRIPT = (ROOT / 'deploy/host/prizecheck-deploy.sh').read_text()
COMPOSE_DEV = (ROOT / 'compose.deploy.yml').read_text()
COMPOSE_PROD = (ROOT / 'compose.prod.yml').read_text()
NGINX = (ROOT / 'deploy/docker/nginx.conf').read_text()
CADDYFILE = (ROOT / 'deploy/oracle/Caddyfile').read_text()
PROD_ENV = (ROOT / 'deploy/host/prizecheck-prod.env.example').read_text()


def uncommented(text):
    return re.sub(r'(?m)^\s*#.*$', '', text)


def between(text, start, end):
    return text[text.index(start):text.index(end)]


def one(pattern, text):
    found = re.findall(pattern, text)
    assert len(found) == 1, (pattern, found)
    return found[0]


class DeployPipelineTest(unittest.TestCase):
    def test_every_deploy_action_is_pinned_to_a_commit(self):
        for name, text in (('deploy-dev.yml', DEV), ('deploy-prod.yml', PROD)):
            uses = re.findall(r'(?m)^\s*-?\s*uses:\s*(\S.*)$', text)
            self.assertTrue(uses, name)
            for line in uses:
                if line.startswith('./'):
                    continue
                self.assertRegex(line, r'@[0-9a-f]{40} # v\d', f'{name}: {line}')

    def test_dev_builds_each_architecture_natively_then_joins_them(self):
        self.assertIn('runner: ubuntu-24.04-arm', DEV)
        self.assertIn('platforms: linux/${{ matrix.arch }}', DEV)
        self.assertIn('arch: [amd64, arm64]', DEV)
        create = one(r'(?m)^.*imagetools create.*$', DEV)
        for part in ('-t "$repo:$GITHUB_SHA"', '-t "$repo:dev"', '"$repo:$GITHUB_SHA-amd64"', '"$repo:$GITHUB_SHA-arm64"'):
            self.assertIn(part, create)
        deploy = between(DEV, '\n  deploy:', '\n  rollback:')
        self.assertRegex(deploy, r'(?m)^    needs: manifests$')

    def test_the_scanner_index_real_model_test_runs_on_arm64(self):
        job = VERIFY[VERIFY.index('  scanner-index-image:'):]
        job = job[:job.index('\n  verify:')]
        self.assertIn('ubuntu-24.04-arm', job)
        self.assertIn('runs-on: ${{ matrix.runner }}', job)

    def test_prod_never_builds_images(self):
        for forbidden in ('build-push-action', 'packages: write', 'imagetools create'):
            self.assertNotIn(forbidden, PROD)
        for required in ('branches: [main]', 'linux/arm64', 'actions/workflows/deploy-dev.yml/runs'):
            self.assertIn(required, PROD)

    def test_every_prod_job_is_gated_and_scoped_to_prod(self):
        jobs = PROD[PROD.index('\njobs:'):]
        names = re.findall(r'(?m)^  ([a-z-]+):$', jobs)
        self.assertEqual(names, ['images', 'deploy', 'rollback'])
        bodies = re.split(r'(?m)^  [a-z-]+:$', jobs)[1:]
        for name, body in zip(names, bodies):
            gates = re.findall(r"(?m)^    if: .*vars\.PROD_DEPLOY_ENABLED == 'true'.*$", body)
            self.assertEqual(len(gates), 1, f'{name} needs its own PROD_DEPLOY_ENABLED gate')
        for required in ('name: prod', 'group: deploy-prod', 'tags: tag:ci-prod', 'secrets.PROD_SSH_PRIVATE_KEY',
                         'vars.PROD_SSH_KNOWN_HOSTS'):
            self.assertIn(required, PROD)
        self.assertNotIn('UNRAID_', PROD)
        self.assertEqual(set(re.findall(r'tag:ci[\w-]*', PROD)), {'tag:ci-prod'})

    def test_no_expression_is_interpolated_inside_a_run_script(self):
        for name, text in (('deploy-dev.yml', DEV), ('deploy-prod.yml', PROD)):
            indent = None
            for line in text.splitlines():
                if indent is not None and (not line.strip() or len(line) - len(line.lstrip()) > indent):
                    self.assertNotIn('${{', line, f'{name}: {line}')
                    continue
                indent = None
                if re.match(r'^\s*(- )?run: \|$', line):
                    indent = len(line) - len(line.lstrip()) + (2 if line.lstrip().startswith('- ') else 0)
                elif re.match(r'^\s*(- )?run: ', line):
                    self.assertNotIn('${{', line, f'{name}: {line}')

    def test_digest_file_lists_match_the_host_script(self):
        self.assertIn('cat compose.deploy.yml deploy/host/prizecheck-deploy.sh | sha256sum', DEV)
        self.assertIn('cat compose.deploy.yml compose.prod.yml deploy/host/prizecheck-deploy.sh | sha256sum', PROD)
        self.assertIn('"$PRIZECHECK_HOME/compose.prod.yml"', SCRIPT)

    def test_the_prod_edge_addresses_agree(self):
        compose = uncommented(COMPOSE_PROD)
        subnet = ipaddress.ip_network(one(r'subnet:\s*(\S+)', compose))
        ip_range = ipaddress.ip_network(one(r'ip_range:\s*(\S+)', compose))
        gateway = ipaddress.ip_address(one(r'gateway:\s*(\S+)', compose))
        web = ipaddress.ip_address(one(r'ipv4_address:\s*(\S+)', compose))
        trusted = ipaddress.ip_address(one(r'TRUSTED_PROXY_IPS:\s*(\S+)', compose))
        self.assertTrue(ip_range.subnet_of(subnet))
        self.assertIn(web, subnet)
        self.assertNotIn(web, ip_range)
        self.assertEqual(web, trusted)
        self.assertIn(gateway, subnet)
        self.assertNotIn(gateway, ip_range)
        realip = ipaddress.ip_address(one(r'set_real_ip_from\s+(\S+);', uncommented(NGINX)))
        self.assertEqual(gateway, realip)

    def test_dev_compose_keeps_dev_behaviour(self):
        for kept in ('TRUSTED_PROXY_IPS: ""', 'MARKETPLACE_MATCHING: automatic', 'SIGNUP_MODE: ${PRIZECHECK_SIGNUP_MODE:-owner-only}',
                     '"${PRIZECHECK_WEB_BIND:-127.0.0.1}:${PRIZECHECK_WEB_PORT:-8088}:8080"'):
            self.assertIn(kept, COMPOSE_DEV)
        self.assertNotIn('ipam', COMPOSE_DEV)

    def test_signup_mode_comes_only_from_the_host_script(self):
        compose = uncommented(COMPOSE_DEV)
        # The default is owner-only; the env file's own SIGNUP_MODE is never interpolated, and the script refuses a
        # PRIZECHECK_SIGNUP_MODE there.
        self.assertEqual(re.findall(r'\$\{[^}]*SIGNUP_(?:MODE|READINESS)[^}]*\}', compose), ['${PRIZECHECK_SIGNUP_MODE:-owner-only}'])
        self.assertIn('RELEASE_COMMIT: ${PRIZECHECK_IMAGE_TAG:-}', compose)
        self.assertIn('SIGNUP_READINESS_FILE: /run/prizecheck/signup/${PRIZECHECK_IMAGE_TAG:-none}.json', compose)
        # Only production mounts the validated proof copy, as a read-only directory (a missing file would become a directory).
        self.assertIn('- ./signup-active:/run/prizecheck/signup:ro', uncommented(COMPOSE_PROD))
        self.assertIn('PRIZECHECK_SIGNUP_MODE="$mode" "${COMPOSE[@]}" "${COMPOSE_ARGS[@]}" "$@"', SCRIPT)
        self.assertIn('SIGNUP_MODE=owner-only', PROD_ENV)

    def test_the_tools_service_gets_the_price_import_contact(self):
        # The price import refuses to run without a contact; only `tools` runs it (prizecheck-deploy.sh tool ...).
        tools = COMPOSE_DEV[COMPOSE_DEV.index('\n  tools:\n'):]
        tools = tools[:tools.index('    depends_on:')]
        self.assertIn('<<: *api-environment', tools)
        self.assertIn('PRICE_IMPORT_CONTACT: ${PRICE_IMPORT_CONTACT:-${OWNER_EMAIL}}', tools)
        self.assertEqual(len(re.findall(r'(?m)^\s*PRICE_IMPORT_CONTACT:', COMPOSE_DEV)), 1)
        for example in ('prizecheck-dev.env.example', 'prizecheck-prod.env.example'):
            text = (ROOT / 'deploy/host' / example).read_text()
            self.assertRegex(uncommented(text), r'(?m)^OWNER_EMAIL=')
            self.assertIn('PRICE_IMPORT_CONTACT', text)

    def test_the_prod_overlay_forces_production(self):
        compose = uncommented(COMPOSE_PROD)
        self.assertEqual(compose.count('NODE_ENV: production'), 3)
        self.assertIn('MAIL_MODE: ${MAIL_MODE:-http}', compose)
        self.assertEqual(compose.count('MARKETPLACE_MATCHING: ${MARKETPLACE_MATCHING:-off}'), 2)
        self.assertNotIn('automatic', compose)

    def test_caddy_forwards_the_visitor_address_and_logs_no_requests(self):
        caddy = uncommented(CADDYFILE)
        self.assertIn('reverse_proxy 127.0.0.1:8088', caddy)
        self.assertIn('header_up X-Real-IP {remote_host}', caddy)
        env = {key: value for key, value in re.findall(r'(?m)^([A-Z_]+)=(.*)$', PROD_ENV)}
        self.assertIn(f"reverse_proxy {env['PRIZECHECK_WEB_BIND']}:{env['PRIZECHECK_WEB_PORT']}", caddy)
        self.assertIn('Strict-Transport-Security', caddy)
        # The only `log` allowed is the global default logger that excludes the request-carrying error loggers.
        self.assertEqual(re.findall(r'(?m)^\s*log\b.*$', caddy), ['\tlog default {'])
        self.assertRegex(caddy, r'(?s)\A\s*\{\s*log default \{\s*exclude http\.log\.error http\.handlers\.reverse_proxy\s*\}\s*\}')
        self.assertNotIn('output', caddy)
        self.assertNotIn('Cross-Origin', caddy)
        self.assertNotIn('encode', caddy)


if __name__ == '__main__':
    unittest.main()
