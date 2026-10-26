"""The local release adapter's static routing (scripts/release_runtime.py) mirrors deploy/docker/nginx.conf for the card
scanner: scan.html at /collection/scan with COOP and COEP, COEP on /assets/ responses, and nothing else isolated."""
from pathlib import Path
import sys
import tempfile
import threading
import types
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
import release_runtime  # noqa: E402

COOP, COEP = 'Cross-Origin-Opener-Policy', 'Cross-Origin-Embedder-Policy'


class ReleaseRuntimeRoutingTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        assets = Path(cls.temp.name)
        (assets / 'assets').mkdir()
        (assets / 'index.html').write_text('<html>app')
        (assets / 'scan.html').write_text('<html>scanner')
        (assets / 'assets/a-1.mjs').write_text('export {}')
        (assets / 'assets/a.js').write_text('1')
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), release_runtime.Handler)
        cls.server.key = 'k'
        cls.server.runtime = types.SimpleNamespace(lock=threading.Lock(), current={'assets': assets})
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.temp.cleanup()

    def get(self, path):
        try:
            with urllib.request.urlopen(f'http://127.0.0.1:{self.server.server_port}{path}', timeout=10) as response:
                return response.status, response.read().decode(), response.headers
        except urllib.error.HTTPError as error:
            error.close()
            return error.code, "", error.headers

    def test_the_scanner_page_is_isolated_at_its_path(self):
        for path in ('/collection/scan', '/collection/scan?from=header'):
            status, body, headers = self.get(path)
            self.assertEqual((status, body), (200, '<html>scanner'))
            self.assertEqual(headers[COOP], 'same-origin')
            self.assertEqual(headers[COEP], 'require-corp')

    def test_the_scanner_file_is_not_served_by_its_name(self):
        self.assertEqual(self.get('/scan.html')[0], 404)

    def test_assets_send_coep_only(self):
        for path in ('/assets/a.js', '/assets/a-1.mjs'):
            status, _, headers = self.get(path)
            self.assertEqual(status, 200)
            self.assertEqual(headers[COEP], 'require-corp')
            self.assertIsNone(headers[COOP])

    def test_no_other_document_is_isolated(self):
        for path in ('/', '/collection', '/collection/import', '/collection/scan/', '/assets/missing.js'):
            status, body, headers = self.get(path)
            self.assertEqual((status, body), (200, '<html>app'), path)
            self.assertIsNone(headers[COOP], path)
            self.assertIsNone(headers[COEP], path)


if __name__ == '__main__':
    unittest.main()
