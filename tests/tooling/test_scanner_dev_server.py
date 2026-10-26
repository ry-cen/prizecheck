"""The Vite dev server serves the scanner's own entry at /collection/scan with the same header scope as nginx
(web/vite-scanner-plugin.ts): COOP and COEP on that document, COEP on module and worker URLs, neither on any other HTML
document. Starts a real dev server on a free port with its own dependency cache; no API or gateway is needed."""
from pathlib import Path
import os
import socket
import subprocess
import tempfile
import time
import unittest
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
COOP, COEP = 'Cross-Origin-Opener-Policy', 'Cross-Origin-Embedder-Policy'


def free_port():
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        return probe.getsockname()[1]


class ScannerDevServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cache = tempfile.TemporaryDirectory(prefix='tcg-scanner-dev-')
        cls.port = free_port()
        env = {**os.environ, 'WEB_PORT': str(cls.port), 'VITE_CACHE_DIR': cls.cache.name}
        cls.server = subprocess.Popen(['node', str(ROOT / 'node_modules/vite/bin/vite.js'), '--config', 'web/vite.config.ts',
                                       '--strictPort', '--logLevel', 'error'], cwd=ROOT, env=env,
                                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            try:
                socket.create_connection(('127.0.0.1', cls.port), timeout=1).close()
                return
            except OSError:
                time.sleep(0.2)
        cls.tearDownClass()
        raise AssertionError('the dev server did not start')

    @classmethod
    def tearDownClass(cls):
        cls.server.terminate()
        cls.server.wait(timeout=20)
        cls.cache.cleanup()

    def get(self, path, **headers):
        request = urllib.request.Request(f'http://127.0.0.1:{self.port}{path}', headers=headers)
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.read().decode(), response.headers

    def test_the_scanner_entry_is_served_isolated_at_its_path(self):
        for path in ('/collection/scan', '/collection/scan?from=header'):
            body, headers = self.get(path, Accept='text/html', **{'Sec-Fetch-Dest': 'document'})
            self.assertIn('/src/scanner/entry/main.tsx', body)
            self.assertNotIn('/src/main.tsx', body)
            self.assertEqual(headers[COOP], 'same-origin')
            self.assertEqual(headers[COEP], 'require-corp')

    def test_no_other_html_document_is_isolated(self):
        for path in ('/', '/collection', '/collection/import', '/collection/scan/'):
            body, headers = self.get(path, Accept='text/html', **{'Sec-Fetch-Dest': 'document'})
            self.assertIn('/src/main.tsx', body, path)
            self.assertIsNone(headers[COOP], path)
            self.assertIsNone(headers[COEP], path)

    def test_the_entry_file_is_not_served_by_its_name(self):
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.get('/scan.html', Accept='text/html', **{'Sec-Fetch-Dest': 'document'})
        caught.exception.close()
        self.assertEqual(caught.exception.code, 404)

    def test_module_and_worker_urls_carry_coep(self):
        for path in ('/src/scanner/entry/main.tsx', '/src/scanner/route.ts', '/src/scanner/models.ts'):
            _, headers = self.get(path, **{'Sec-Fetch-Dest': 'script'})
            self.assertEqual(headers[COEP], 'require-corp', path)
            self.assertIsNone(headers[COOP], path)
        _, headers = self.get('/src/scanner/entry/main.tsx?worker_file&type=module', **{'Sec-Fetch-Dest': 'worker'})
        self.assertEqual(headers[COEP], 'require-corp')


if __name__ == '__main__':
    unittest.main()
