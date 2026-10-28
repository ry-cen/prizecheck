"""The deployment pipeline's wiring (spec: docs/deployment-oracle.md, docs/deployment-unraid.md): one shared build
checks the commit, builds each architecture natively and joins them, dev deploys only by hand, production reuses a dev
build or runs the same shared build itself, and the addresses that make
up the client-IP chain (compose.prod.yml, deploy/docker/nginx.conf, deploy/oracle/Caddyfile) agree. Text and regex only:
no YAML library is available to the tooling tests."""
import ipaddress
import json
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[2]
DEV = (ROOT / '.github/workflows/deploy-dev.yml').read_text()
BUILD = (ROOT / '.github/workflows/build-images.yml').read_text()
PROD = (ROOT / '.github/workflows/deploy-prod.yml').read_text()
VERIFY = (ROOT / '.github/workflows/verify.yml').read_text()
SCRIPT = (ROOT / 'deploy/host/prizecheck-deploy.sh').read_text()
COMPOSE_DEV = (ROOT / 'compose.deploy.yml').read_text()
COMPOSE_PROD = (ROOT / 'compose.prod.yml').read_text()
NGINX = (ROOT / 'deploy/docker/nginx.conf').read_text()
UNIT_SERVICE = (ROOT / 'deploy/host/prizecheck-catalog-refresh.service').read_text()
UNIT_TIMER = (ROOT / 'deploy/host/prizecheck-catalog-refresh.timer').read_text()
CADDYFILE = (ROOT / 'deploy/oracle/Caddyfile').read_text()
PROD_ENV = (ROOT / 'deploy/host/prizecheck-prod.env.example').read_text()


def uncommented(text):
    return re.sub(r'(?m)^\s*#.*$', '', text)


def between(text, start, end):
    return text[text.index(start):text.index(end)]


RELEASE_PR = "github.event_name == 'pull_request' && github.base_ref == 'main'"


def job_body(name):
    """The text of one verify.yml job, from its key to the next job's key."""
    jobs = VERIFY[VERIFY.index('\njobs:'):]
    start = jobs.index(f'\n  {name}:\n') + 1
    following = re.search(r'(?m)^  [a-z][a-z-]*:$', jobs[start + 1 + len(name) + 3:])
    end = start + 1 + len(name) + 3 + following.start() if following else len(jobs)
    body = jobs[start:end].rstrip('\n')
    # Drop the comment block that introduces the next job.
    return re.sub(r'(\n  #[^\n]*)+$', '', body) + '\n'


def one(pattern, text):
    found = re.findall(pattern, text)
    assert len(found) == 1, (pattern, found)
    return found[0]


class DeployPipelineTest(unittest.TestCase):
    def test_every_deploy_action_is_pinned_to_a_commit(self):
        for name, text in (('deploy-dev.yml', DEV), ('build-images.yml', BUILD), ('deploy-prod.yml', PROD)):
            uses = re.findall(r'(?m)^\s*-?\s*uses:\s*(\S.*)$', text)
            self.assertTrue(uses, name)
            for line in uses:
                if line.startswith('./'):
                    continue
                self.assertRegex(line, r'@[0-9a-f]{40} # v\d', f'{name}: {line}')

    def test_the_shared_build_builds_each_architecture_natively_then_joins_them(self):
        self.assertIn('runner: ubuntu-24.04-arm', BUILD)
        self.assertIn('platforms: linux/${{ matrix.arch }}', BUILD)
        self.assertIn('arch: [amd64, arm64]', BUILD)
        create = one(r'(?m)^.*imagetools create.*$', BUILD)
        for part in ('-t "$repo:$GITHUB_SHA"', '-t "$repo:$POINTER"', '"$repo:$GITHUB_SHA-amd64"', '"$repo:$GITHUB_SHA-arm64"'):
            self.assertIn(part, create)
        self.assertRegex(BUILD, r'(?m)^  workflow_call:$')
        # A caller's env doesn't reach a called workflow, so the build names its own registry.
        self.assertRegex(BUILD, r'(?m)^  REGISTRY: ghcr\.io/ry-cen$')
        self.assertNotRegex(BUILD, r'(?m)^  (push|pull_request|workflow_dispatch):')

    def test_dev_deploys_only_when_run_by_hand(self):
        trigger = between(DEV, '\non:', '\npermissions:')
        self.assertIn('workflow_dispatch:', trigger)
        self.assertNotIn('push:', trigger)
        self.assertRegex(between(DEV, '\n  build:', '\n  deploy:'), r'uses: \./\.github/workflows/build-images\.yml')
        self.assertRegex(between(DEV, '\n  deploy:', '\n  rollback:'), r'(?m)^    needs: build$')
        for forbidden in ('build-push-action', 'imagetools create'):
            self.assertNotIn(forbidden, DEV)
        self.assertIn('pointer: dev', DEV)

    def test_the_scanner_index_image_builds_on_both_architectures_without_the_real_model_test(self):
        job = job_body('scanner-index-image')
        self.assertIn('ubuntu-24.04-arm', job)
        self.assertIn('runs-on: ${{ matrix.runner }}', job)
        self.assertIn('push: false', job)
        self.assertNotIn('target: test', job)
        self.assertNotIn('docker run', job)

    def test_the_scanner_real_model_test_is_an_optional_integration_job_on_both_architectures(self):
        job = job_body('integration-scanner-model')
        self.assertIn('ubuntu-24.04-arm', job)
        self.assertIn('target: test', job)
        self.assertIn('docker run --rm prizecheck-scanner-index-test', job)
        self.assertIn("inputs.integration == 'sharded' || inputs.integration == 'full' || (" + RELEASE_PR + ')', job)

    def test_the_default_checks_need_no_database_and_no_browser(self):
        checks = job_body('checks')
        for required in ('npm ci', 'api/requirements.txt', 'npx prettier --check .', 'npm run guardrails', 'npm run check',
                         'compileall -q api scripts', 'vite build', 'npm run check:bundle', 'npm run test:unit'):
            self.assertIn(required, checks)
        self.assertNotRegex(uncommented(checks), r'(?m)^\s+if:')
        for forbidden in ('postgres', 'playwright', 'npm run verify', 'TEST_ADMIN_DATABASE_URL', 'services:'):
            self.assertNotIn(forbidden, checks.lower() if forbidden.islower() else checks)

    def test_the_unit_test_script_leaves_out_integration_and_model_tests(self):
        script = json.loads((ROOT / 'package.json').read_text())['scripts']['test:unit']
        self.assertIn('web/src', script)
        self.assertNotIn('auth/tests', script)
        for excluded in ('**/*.local.test.ts', '**/*.models.test.ts'):
            self.assertIn(f'--exclude "{excluded}"', script)

    def test_the_integration_jobs_run_only_when_a_dispatch_asks_for_them(self):
        on = VERIFY[:VERIFY.index('\njobs:')]
        self.assertRegex(on, r'(?m)^  workflow_dispatch:$')
        self.assertRegex(on, r'(?m)^      integration:$')
        self.assertRegex(on, r'(?m)^        options:\n          - none\n          - sharded\n          - full\n        default: none$')
        self.assertNotIn('inputs.full', VERIFY)
        # Sharded is also due on every pull request to main (a release); the unsharded full gate only on request.
        self.assertIn(f"    if: ${{{{ inputs.integration == 'sharded' || ({RELEASE_PR}) }}}}", job_body('integration-legs'))
        self.assertIn("    if: ${{ inputs.integration == 'full' }}", job_body('integration-full'))
        self.assertNotIn('pull_request', job_body('integration-full'))
        self.assertNotIn('pull_request', job_body('checks'))
        self.assertNotIn('pull_request', job_body('scanner-index-image'))
        # The deep suites live only in the optional jobs.
        for name in ('checks', 'scanner-index-image', 'verify'):
            body = job_body(name)
            for deep in ('playwright', 'postgres', 'npm run verify'):
                self.assertNotIn(deep, body.lower(), f'{name} must not run {deep}')
        legs = job_body('integration-legs')
        for arg in ('--suite api --fast --shard 1/3', '--suite api --fast --shard 3/3', '--suite auth --fast',
                    '--suite browser --fast --shard 1/10', '--suite browser --fast --shard 10/10'):
            self.assertIn(arg, legs)
        self.assertEqual(len(re.findall(r'(?m)^          - leg: ', legs)), 14)
        self.assertIn('run: npm run verify\n', job_body('integration-full'))

    def test_the_verify_aggregator_requires_the_default_checks_and_every_requested_job(self):
        verify = job_body('verify')
        jobs = ['checks', 'scanner-index-image', 'integration-legs', 'integration-full', 'integration-scanner-model']
        needs = re.search(r'needs:\s*\[([^\]]*)\]', verify).group(1)
        self.assertEqual([n.strip() for n in needs.split(',') if n.strip()], jobs)
        # always() keeps it from being skipped with a failed or cancelled job; a skipped check counts as passing.
        self.assertRegex(verify, r'(?m)^    if: \$\{\{ always\(\) \}\}$')
        for name in jobs:
            self.assertIn(f'needs.{name}.result', verify)
        script = verify[verify.index('run: |'):]
        for required in ('test "$CHECKS_RESULT" = success', 'test "$SCANNER_INDEX_RESULT" = success',
                         'none) legs=skipped; full=skipped; model=skipped ;;',
                         'sharded) legs=success; full=skipped; model=success ;;',
                         'full) legs=skipped; full=success; model=success ;;',
                         'test "$LEGS_RESULT" = "$legs"', 'test "$FULL_RESULT" = "$full"', 'test "$SCANNER_MODEL_RESULT" = "$model"'):
            self.assertIn(required, script)
        # A pull request to main is due the sharded jobs even with no input, so skipped legs cannot pass there.
        self.assertIn("RELEASE_PR: ${{ " + RELEASE_PR + " && 'true' || 'false' }}", verify)
        self.assertIn('if [ "$RELEASE_PR" = true ] && [ "$INTEGRATION" = none ]; then INTEGRATION=sharded; fi', script)
        self.assertLess(script.index('RELEASE_PR" = true'), script.index('case "$INTEGRATION"'))
        # An unrecognised choice fails instead of passing with everything skipped.
        self.assertIn('exit 1', script)

    def test_the_shared_build_gates_its_images_on_the_verify_check(self):
        self.assertRegex(between(BUILD, '\n  verify:', '\n  images:'), r'uses: \./\.github/workflows/verify\.yml')
        self.assertRegex(between(BUILD, '\n  images:', '\n    runs-on'), r'(?m)^    needs: verify$')
        self.assertNotRegex(PROD, r'verify\.yml')

    def test_prod_builds_only_through_the_shared_build_when_images_are_missing(self):
        for forbidden in ('build-push-action', 'imagetools create'):
            self.assertNotIn(forbidden, PROD)
        for required in ('branches: [main]', 'linux/arm64', 'missing=true', 'missing=false'):
            self.assertIn(required, PROD)
        build = between(PROD, '\n  build:', '\n  deploy:')
        self.assertRegex(build, r'uses: \./\.github/workflows/build-images\.yml')
        self.assertIn('pointer: main', build)
        # Only the build may push; finding and deploying the images only read them.
        self.assertEqual(PROD.count('packages: write'), 1)
        self.assertIn('packages: write', build)
        self.assertIn('packages: read', between(PROD, '\n  images:', '\n  build:'))
        self.assertIn("needs.images.outputs.missing == 'true'", build)
        deploy = between(PROD, '\n  deploy:', '\n  rollback:')
        self.assertRegex(deploy, r'(?m)^    needs: \[images, build\]$')
        for required in ("needs.images.result == 'success'", "needs.build.result == 'success'",
                         "needs.build.result == 'skipped'", '!cancelled()'):
            self.assertIn(required, deploy)

    def test_every_prod_job_is_gated_and_scoped_to_prod(self):
        jobs = PROD[PROD.index('\njobs:'):]
        names = re.findall(r'(?m)^  ([a-z-]+):$', jobs)
        self.assertEqual(names, ['images', 'build', 'deploy', 'rollback'])
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
        for name, text in (('deploy-dev.yml', DEV), ('build-images.yml', BUILD), ('deploy-prod.yml', PROD)):
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
        units = ('deploy/host/prizecheck-catalog-refresh.service deploy/host/prizecheck-catalog-refresh.timer '
                 'deploy/host/prizecheck-backup.service deploy/host/prizecheck-backup.timer')
        self.assertIn(f'cat compose.deploy.yml deploy/host/prizecheck-deploy.sh {units} | sha256sum', DEV)
        self.assertIn(f'cat compose.deploy.yml compose.prod.yml deploy/host/prizecheck-deploy.sh {units} | sha256sum', PROD)
        # The host script concatenates in the same order, and the guides quote the same recipe.
        self.assertIn('HOST_UNITS=("$REFRESH_SERVICE" "$REFRESH_TIMER" "$BACKUP_SERVICE" "$BACKUP_TIMER")', SCRIPT)
        self.assertIn('cat "${COMPOSE_FILES[@]}" "$SCRIPT_PATH" "${files[@]}" | sha256sum', SCRIPT)
        self.assertIn(f'cat compose.deploy.yml compose.prod.yml deploy/host/prizecheck-deploy.sh {units} | sha256sum',
                      (ROOT / 'docs/deployment-oracle.md').read_text())
        self.assertIn(f'cat compose.deploy.yml deploy/host/prizecheck-deploy.sh {units} | sha256sum',
                      (ROOT / 'docs/deployment-unraid.md').read_text())
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
        for kept in ('TRUSTED_PROXY_IPS: ""', 'SIGNUP_MODE: ${PRIZECHECK_SIGNUP_MODE:-owner-only}',
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

    def test_the_catalog_importer_and_check_get_the_same_user_agent_contact(self):
        # api (owner-started imports) and tools (the daily check) share the anchor that carries the contact.
        anchor = COMPOSE_DEV[COMPOSE_DEV.index('x-api-environment:'):COMPOSE_DEV.index('\nservices:')]
        self.assertIn('SCANNER_INDEX_CONTACT: ${SCANNER_INDEX_CONTACT:-${OWNER_EMAIL}}', anchor)
        for service in ('api', 'tools'):
            block = COMPOSE_DEV[COMPOSE_DEV.index(f'\n  {service}:\n'):]
            block = block[:block.index('    depends_on:')]
            self.assertTrue('environment: *api-environment' in block or '<<: *api-environment' in block, service)

    def test_catalog_refresh_is_a_subcommand_with_its_own_lock(self):
        body = SCRIPT[SCRIPT.index('cmd_catalog_refresh() {'):SCRIPT.index('cmd_compose() {')]
        self.assertIn('catalog-refresh) cmd_catalog_refresh ;;', SCRIPT)
        self.assertIn('catalog-refresh ', SCRIPT[SCRIPT.index('usage() {'):SCRIPT.index('ssh_gate() {')])
        # Its own non-blocking lock on fd 8; deploy.lock (take_lock, fd 9), which a deploy waits only 120 s for, is only
        # probed without waiting and never held.
        self.assertIn('exec 8>"$STATE_DIR/catalog-refresh.lock"', body)
        self.assertIn('flock -n 8', body)
        self.assertNotIn('take_lock', body)
        self.assertNotIn('9>', body)
        self.assertNotIn('flock -w', body)  # nothing here waits for or holds deploy.lock; the helper only probes it
        self.assertGreaterEqual(body.count('deploy_lock_held'), 4)  # at the start, before the check, before the index, before the record call
        probe = SCRIPT[SCRIPT.index('deploy_lock_held() {'):SCRIPT.index('cmd_catalog_refresh() {')]
        self.assertIn('flock -n "$STATE_DIR/deploy.lock" true', probe)
        self.assertIn('1) return 0', probe)  # only status 1 is "held"; anything else dies
        self.assertIn('-m app.catalog_refresh', body)
        self.assertIn('--record-index', body)
        # The price import (ADR 0019) is the first container run, labelled like the others, ahead of the check.
        price = 'tools /app/scripts/price_import_job.py </dev/null'
        self.assertIn(price, body)
        self.assertIn('-l "$CATALOG_REFRESH_LABEL" ' + price, body)
        self.assertLess(body.index(price), body.index('-m app.catalog_refresh'))
        self.assertLess(body.index(price), body.index('scanner-index'))

    def test_the_catalog_refresh_units_run_the_subcommand_daily_and_not_on_boot(self):
        self.assertIn('Type=oneshot', UNIT_SERVICE)
        self.assertRegex(UNIT_SERVICE, r'(?m)^Description=.*price import.*catalog change check.*scanner index')
        self.assertIn('ExecStart=/bin/bash /opt/prizecheck-prod/bin/prizecheck-deploy.sh catalog-refresh\n', UNIT_SERVICE)
        self.assertIn('TimeoutStartSec=infinity', UNIT_SERVICE)
        self.assertNotIn('Restart=', UNIT_SERVICE)
        self.assertNotIn('[Install]', UNIT_SERVICE)  # only the timer is enabled
        self.assertIn('OnCalendar=*-*-* 04:00:00 UTC\n', UNIT_TIMER)
        self.assertRegex(UNIT_TIMER, r'(?m)^RandomizedDelaySec=\d+min$')
        self.assertIn('Persistent=true', UNIT_TIMER)
        self.assertIn('WantedBy=timers.target', UNIT_TIMER)
        self.assertNotRegex(UNIT_TIMER, r'(?m)^(OnBootSec|OnStartupSec|OnActiveSec)=')
        self.assertIn('catalog-refresh) cmd_catalog_refresh ;;', SCRIPT)

    def test_the_guides_name_only_files_commands_and_anchors_that_exist(self):
        usage = SCRIPT[SCRIPT.index('usage() {'):SCRIPT.index('ssh_gate() {')]
        commands = set(re.findall(r'(?m)^  ([a-z][a-z-]+)\b', usage))
        self.assertIn('readiness', commands)
        for guide in ('deployment-oracle.md', 'deployment-unraid.md'):
            text = (ROOT / 'docs' / guide).read_text()
            for path in set(re.findall(r'(?<![\w/.-])((?:deploy|scripts|docs|api|compose)[\w./-]*\.(?:sh|py|md|yml|service|timer|example)|deploy/oracle/Caddyfile)\b', text)):
                if path.startswith('docs/'):
                    self.assertTrue((ROOT / path).exists() or (ROOT / 'docs' / path[5:]).exists(), f'{guide}: {path}')
                elif '/' in path or path.endswith(('.yml', '.service', '.timer')):
                    self.assertTrue((ROOT / path).exists(), f'{guide}: {path}')
            for command in re.findall(r'(?m)^\s*(?:sudo )?bash \S*prizecheck-deploy\.sh ([a-z][a-z-]+)', text):
                self.assertIn(command, commands, f'{guide}: {command}')
            headings = {re.sub(r'[^a-z0-9 -]', '', h.lower()).strip().replace(' ', '-')
                        for h in re.findall(r'(?m)^#{1,6} (.+)$', text)}
            for anchor in re.findall(r'\]\(#([a-z0-9-]+)\)', text):
                self.assertIn(anchor, headings, f'{guide}: #{anchor}')
        # The three-part layout, and none of the hand-written pieces it replaces.
        for guide in ('deployment-oracle.md', 'deployment-unraid.md'):
            text = (ROOT / 'docs' / guide).read_text()
            parts = re.findall(r'(?m)^## (Part [123])\.', text)
            self.assertEqual(parts, ['Part 1', 'Part 2', 'Part 3'], guide)
            self.assertNotIn('| sudo tee /etc/cron.d', text)
        self.assertNotIn('Install the daily catalog refresh timer', (ROOT / 'docs/deployment-oracle.md').read_text())

    def test_the_backup_units_run_the_subcommand_nightly_and_the_script_lists_readiness(self):
        service = (ROOT / 'deploy/host/prizecheck-backup.service').read_text()
        timer = (ROOT / 'deploy/host/prizecheck-backup.timer').read_text()
        self.assertIn('ExecStart=/bin/bash /opt/prizecheck-prod/bin/prizecheck-deploy.sh backup\n', service)
        self.assertIn('OnCalendar=*-*-* 03:17:00 UTC\n', timer)
        self.assertIn('backup) cmd_backup ;;', SCRIPT)
        self.assertIn('readiness) cmd_readiness ;;', SCRIPT)
        # Neither is reachable through the CI gate.
        gate = SCRIPT[SCRIPT.index('ssh_gate() {'):SCRIPT.index('main() {')]
        self.assertNotIn('readiness', gate)
        self.assertNotIn('backup', gate)

    def test_the_prod_overlay_forces_production(self):
        compose = uncommented(COMPOSE_PROD)
        self.assertEqual(compose.count('NODE_ENV: production'), 3)
        self.assertIn('MAIL_MODE: ${MAIL_MODE:-http}', compose)
        self.assertNotIn('MARKETPLACE_MATCHING', compose)
        self.assertNotIn('automatic', compose)

    def test_api_and_tools_get_the_release_commit(self):
        # The API applies its release's newest catalog rules at startup and the tools image restores them on a rollback
        # (ADR 0021); both read the release commit from the image tag.
        block = COMPOSE_DEV[COMPOSE_DEV.index('x-api-environment: &api-environment'):COMPOSE_DEV.index('\nservices:')]
        self.assertIn('RELEASE_COMMIT: ${PRIZECHECK_IMAGE_TAG:-}', block)
        tools = COMPOSE_DEV[COMPOSE_DEV.index('\n  tools:\n'):]
        self.assertIn('<<: *api-environment', tools[:tools.index('    depends_on:')])
        api = re.search(r'(?s)\n  api:\n(.*?)\n  [a-z]+:\n', COMPOSE_DEV).group(1)
        self.assertIn('environment: *api-environment', api)

    def test_marketplace_matching_is_gone(self):
        paths = [*ROOT.glob('compose*.yml'), *(ROOT / 'deploy/host').glob('*.env.example'), ROOT / '.env.example',
                 *(ROOT / 'api/app').rglob('*.py'),
                 *(path for path in (ROOT / 'docs').rglob('*.md') if not {'planning', 'adr'} & set(path.relative_to(ROOT / 'docs').parts))]
        self.assertTrue(paths)
        self.assertEqual([str(path.relative_to(ROOT)) for path in paths if 'MARKETPLACE_MATCHING' in path.read_text()], [])

    def test_rollback_restores_the_rules_before_starting_the_previous_release(self):
        helper = SCRIPT[SCRIPT.index('restore_rules() {'):SCRIPT.index('cmd_rollback() {')]
        self.assertLess(helper.index('compose stop api'), helper.index('rule_rollout.py restore --to "$target"'))
        rollback = SCRIPT[SCRIPT.index('cmd_rollback() {'):SCRIPT.index('cmd_status() {')]
        self.assertLess(rollback.index('restore_rules "$current" "$previous"'), rollback.index('start_release "$previous"'))

    def test_a_failed_deploy_restores_the_running_releases_rules_before_restarting_it(self):
        deploy = SCRIPT[SCRIPT.index('failed its health checks; rolling back'):SCRIPT.index('Deployment of $commit failed; see the log above')]
        self.assertLess(deploy.index('restore_rules "$commit" "$current"'), deploy.index('restore_release "$current"'))

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
