import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('guardrails', Path(__file__).resolve().parents[2]/'scripts/check_guardrails.py')
guardrails = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guardrails)


class GuardrailTest(unittest.TestCase):
    def test_private_transport_bypass_is_rejected(self):
        self.assertTrue(guardrails.violations('def forward():\n return urllib.request.urlopen(request)', 'release_runtime.py'))

    def test_raw_external_exception_is_rejected(self):
        self.assertTrue(guardrails.violations('try: run()\nexcept Exception as error: print(str(error))', 'release_runtime.py'))

    def test_fixed_release_errors_are_allowed(self):
        self.assertFalse(guardrails.violations('if isinstance(error, ReleaseError):\n print(str(error))\nelse:\n print("Operation failed")', 'release_runtime.py'))

    def test_ambient_proxy_helper_is_rejected(self):
        self.assertTrue(guardrails.violations('def direct_http_open(request, timeout):\n return urllib.request.build_opener().open(request)', 'release.py'))

    def test_aliased_transport_bypass_is_rejected(self):
        self.assertTrue(guardrails.violations('from urllib.request import urlopen as send\ndef forward():\n return send(request)', 'release_runtime.py'))

    def test_named_external_exception_is_rejected(self):
        self.assertTrue(guardrails.violations('try: run()\nexcept Exception as failure: print(str(failure))', 'release_runtime.py'))

    def test_dynamic_release_error_is_rejected(self):
        self.assertTrue(guardrails.violations('raise ReleaseError(str(error))', 'release_runtime.py'))

    def test_interpolated_external_exception_is_rejected(self):
        self.assertTrue(guardrails.violations('try: run()\nexcept Exception as error: print(f"Failed: {error}")', 'release_runtime.py'))

    def test_host_wide_process_search_is_rejected(self):
        for source in ('subprocess.run(["pkill", "-f", "app.price_runner"])', 'run("pgrep", ["-f", "uvicorn"])', 'killall node'):
            self.assertTrue(guardrails.process_search_violations(source), source)

    def test_scoped_process_cleanup_is_allowed(self):
        self.assertFalse(guardrails.process_search_violations('os.killpg(pid, signal.SIGKILL)\nrun("ps", ["-o", "pid=", "-p", pids])'))

    def test_runner_test_without_tier_marks_is_rejected(self):
        self.assertTrue(guardrails.tier_violations('def test_runner(fs_env, proc):\n pass', 'test_x.py'))
        self.assertTrue(guardrails.tier_violations('@pytest.mark.slow(reason="process: real runner")\ndef test_runner(proc):\n pass', 'test_x.py'))

    def test_runner_test_with_tier_marks_is_allowed(self):
        source = ('@pytest.mark.serial(reason="process: asserts real runner timing")\n'
                  '@pytest.mark.slow(reason="process: launches real runner processes")\n'
                  'def test_runner(fs_env, proc):\n pass')
        self.assertFalse(guardrails.tier_violations(source, 'test_x.py'))

    def test_slow_mark_needs_a_category(self):
        for mark in ('@pytest.mark.slow', '@pytest.mark.slow(reason="takes a while")', '@pytest.mark.slow("process: x")'):
            self.assertTrue(guardrails.tier_violations(f'{mark}\ndef test_x():\n pass', 'test_x.py'), mark)
        self.assertFalse(guardrails.tier_violations('@pytest.mark.slow(reason="capacity: 25 000 Editions")\ndef test_x():\n pass', 'test_x.py'))

    def test_serial_mark_needs_a_reason(self):
        self.assertTrue(guardrails.tier_violations('@pytest.mark.serial\ndef test_x():\n pass', 'test_x.py'))
        self.assertFalse(guardrails.tier_violations('@pytest.mark.serial(reason="wall-clock: asserts < 0.3 s")\ndef test_x():\n pass', 'test_x.py'))


class FlakeGuardrailTest(unittest.TestCase):
    SPEC = 'web/tests/moves.spec.ts'
    AUTH = 'auth/tests/gateway.test.ts'
    PROBE = ('for (let n = 0; n < 50; n++) {\n  try {\n    if ((await fetch(base + "/auth/session")).ok) break;\n'
             '  } catch {\n    /* startup */\n  }\n  await sleep(100);\n}')

    def flagged(self, source, filename=SPEC):
        return [line for line, _ in guardrails.flake_violations(source, filename)]

    def test_fixed_browser_sleeps_are_rejected(self):
        self.assertEqual(self.flagged('await page.click("a");\nawait page.waitForTimeout(300);'), [2])
        self.assertEqual(self.flagged('await page.waitForTimeout(300);', self.AUTH), [])

    def test_a_reasoned_quiet_period_is_allowed(self):
        for comment in ('// flake-exempt wait-for-timeout (quiet): no third batch may start while two are held\n',
                        '// Two batches are held.\n// flake-exempt wait-for-timeout (quiet): no third batch may start\n// here.\n'):
            self.assertEqual(self.flagged(f'{comment}    await page.waitForTimeout(800);'), [], comment)

    def test_an_exemption_must_sit_directly_above_with_its_category_and_a_reason(self):
        sleep = 'await page.waitForTimeout(800);'
        for source in (f'// flake-exempt wait-for-timeout (quiet): no batch may start\n\n{sleep}',
                       f'// flake-exempt wait-for-timeout (later): no batch may start\n{sleep}',
                       f'// flake-exempt wait-for-timeout (quiet): settle\n{sleep}',
                       f'// flake-exempt one-shot-read (invariant): no batch may start\n{sleep}',
                       f'// flake-exempt wait-for-timeout: no batch may start\n{sleep}'):
            self.assertTrue(self.flagged(source), source)
        reasons = [reason for _, reason in guardrails.flake_violations(f'// flake-exempt wait-for-timeout (later): x y z\n{sleep}', self.SPEC)]
        self.assertIn('takes (quiet)', reasons[0])

    def test_mentions_in_comments_are_not_patterns(self):
        self.assertEqual(self.flagged('// never page.waitForTimeout(300) or expect(await row.count()) here'), [])

    def test_one_shot_reads_of_browser_state_are_rejected(self):
        for source in ('expect(await link.getAttribute("href")).not.toBe(firstUrl);',
                       'expect(\n  await tiles(page).count()\n).toBe(2);',
                       'expect(await panel.boundingBox()).toEqual({ x: 0, y: 0 });',
                       'expect.soft(await row.isVisible()).toBe(true);',
                       'expect(\n  await page.getByRole("button", { name: "Undo" }).textContent()\n).toBe("Undo");',
                       'expect(await field.inputValue()).toBe("2");'):
            self.assertEqual(self.flagged(source), [1], source)

    def test_retrying_assertions_and_other_awaited_values_are_allowed(self):
        for source in ('await expect(link).not.toHaveAttribute("href", firstUrl);',
                       'await expect(tiles(page)).not.toHaveCount(0);',
                       'await expect.poll(() => panel.boundingBox()).toEqual(box);',
                       'expect(await response.text()).toBe("");',
                       'expect((await tree.json()).locations).toHaveLength(2);',
                       'expect(\n  await page.evaluate(() => document.documentElement.scrollWidth)\n).toBeLessThanOrEqual(375);',
                       'expect(await page.evaluate(() => rows.count())).toBe(1);',
                       'const box = await expectTouchTarget(button);'):
            self.assertEqual(self.flagged(source), [], source)

    def test_a_sample_of_an_invariant_may_stay_one_shot(self):
        source = ('// flake-exempt one-shot-read (invariant): the gallery never mounts more than 400 tiles\n'
                  'expect(await tiles(page).count()).toBeLessThanOrEqual(400);')
        self.assertEqual(self.flagged(source), [])

    def test_touch_target_sizes_go_through_expect_touch_target(self):
        for source in ('expect(box.height).toBeGreaterThanOrEqual(44);', 'expect(box!.width).toBeGreaterThanOrEqual(43.5);',
                       'expect(box.height).toBeGreaterThan(43);',
                       '// flake-exempt touch-target (invariant): measured once on purpose\nexpect(box.height).toBeGreaterThanOrEqual(44);'):
            self.assertTrue(self.flagged(source), source)
        self.assertEqual(self.flagged('expect(box[dimension]).toBeGreaterThanOrEqual(TOUCH_TARGET - ALLOWANCE);'), [])
        self.assertEqual(self.flagged('expect(box.width).toBeGreaterThanOrEqual(44);', 'web/tests/support/touch-target.ts'), [])
        self.assertEqual(self.flagged('expect(ring.width).toBeGreaterThanOrEqual(2);\nexpect(box.width).toBeGreaterThanOrEqual(110);'), [])

    def test_counted_loops_that_sleep_are_rejected_in_auth_tests(self):
        drain = ('for (let n = 0; n < 50; n++) {\n  const { rows } = await admin.query(sql, [database]);\n'
                 '  if (rows[0].count === 0) break;\n  await new Promise((resolve) => setTimeout(resolve, 100));\n}')
        for source in (self.PROBE, drain, 'for (let n = 0; n < 30 && blocked > 0; n++) await sleep(50);',
                       'for (let attempt = 0; attempt < 100 && !ready; attempt += 1) {\n  try { ready = await probe(); }\n'
                       '  catch { await new Promise((resolve) => setTimeout(resolve, 100)); }\n}'):
            self.assertEqual(self.flagged(source, self.AUTH), [1], source)
        self.assertEqual(self.flagged(self.PROBE, 'auth/tests/price-runners-harness.ts'), [1])
        self.assertEqual(self.flagged(self.PROBE, self.SPEC), [])

    def test_deadline_waits_and_counted_retries_without_sleeps_are_allowed(self):
        for source in ('const end = performance.now() + limit;\nfor (;;) {\n  if (await probe()) return;\n  await sleep(step);\n}',
                       'for (let attempt = 0; attempt < 20; attempt++) {\n  const done = await relay("transact");\n'
                       '  if (done.committed) return;\n}',
                       'for (let n = 0; n < count; n++) addJobs(full, `user:queue-${n}`, 32);',
                       'for (let i = 0; i < 3; i++)\n  expect((await post("/auth/verify-code", body)).status).toBe(401);',
                       '// flake-exempt counted-wait (retry): each attempt re-sends a refused write, not a probe\n' + self.PROBE):
            self.assertEqual(self.flagged(source, self.AUTH), [], source)

    def test_a_workspace_sign_in_starts_as_a_new_owner(self):
        sign_in = 'async function signIn(page: Page) {\n  await pool.query("DELETE FROM auth_send_event");\n}'
        self.assertEqual(self.flagged(sign_in, 'web/tests/workspace-moves.spec.ts'), [1])
        self.assertEqual(self.flagged('// flake-exempt fresh-owner (quiet): this spec keeps the tree\n' + sign_in,
                                      'web/tests/workspace-moves.spec.ts'), [2])
        fresh = sign_in.replace('auth_send_event");', 'auth_send_event");\n  await startAsNewOwner(pool);')
        self.assertEqual(self.flagged(fresh, 'web/tests/workspace-moves.spec.ts'), [])
        commented = sign_in.replace('auth_send_event");', 'auth_send_event");\n  // await startAsNewOwner(pool);')
        self.assertEqual(self.flagged(commented, 'web/tests/workspace-moves.spec.ts'), [1])
        self.assertEqual(self.flagged(sign_in, 'web/tests/holdings.spec.ts'), [])
        self.assertEqual(self.flagged(sign_in, 'web/tests/support/workspace-sign-in.ts'), [])


    def test_shipped_auth_importing_the_oauth_fake_is_rejected(self):
        for source in ('import "../testing/oauth-fake/preload.js";',
                       'import { identities } from "../testing/oauth-fake/core.js";',
                       "export * from '../../auth/testing/oauth-fake/core.js';",
                       'const fake = await import("../testing/oauth-fake/core.js");',
                       'const fake = require("./oauth-fake");',
                       'if (url.pathname === "/auth/__fake-oauth/consent") serve();'):
            self.assertTrue(guardrails.oauth_fake_import_violations(source), source)

    def test_shipped_auth_imports_are_allowed(self):
        source = ('import { createServer } from "node:http";\n'
                  'import { auth, pool } from "./auth.js";\n'
                  'import { betterAuth } from "better-auth";\n'
                  'const label = "testing mode";\n'
                  '// the gateway has no fake extension point\n')
        self.assertFalse(guardrails.oauth_fake_import_violations(source))

    def test_dockerignore_must_exclude_the_oauth_fake(self):
        self.assertTrue(guardrails.dockerignore_violations('**/.env\n.git/\n'))
        self.assertFalse(guardrails.dockerignore_violations('**/.env\nauth/testing/\n.git/\n'))
