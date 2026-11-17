"""The local release adapter's static routing (scripts/release_runtime.py) mirrors deploy/docker/nginx.conf for the card
scanner: scan.html at /collection/scan with COOP and COEP, COEP on /assets/ responses, and nothing else isolated. It also
forwards /robots.txt and /sitemap.xml to the auth bundle as /api/public/robots.txt and /api/public/sitemap.xml."""
from pathlib import Path
import sys
import tempfile
import threading
import types
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

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
        cls.seen = []
        cls.upstream = ThreadingHTTPServer(('127.0.0.1', 0), cls.upstream_handler())
        threading.Thread(target=cls.upstream.serve_forever, daemon=True).start()
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), release_runtime.Handler)
        cls.server.key = 'k'
        cls.server.runtime = types.SimpleNamespace(lock=threading.Lock(), current={'assets': assets, 'auth': f'http://127.0.0.1:{cls.upstream.server_port}'})
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def upstream_handler(cls):
        seen = cls.seen
        cls.bodies = []
        bodies = cls.bodies

        class Upstream(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                seen.append((self.command, self.path))
                bodies.append(self.rfile.read(int(self.headers.get('Content-Length', '0'))))
                body = b'upstream'
                self.send_response(200)
                self.send_header('Content-Type', 'text/plain')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            do_POST = do_GET

        return Upstream

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.upstream.shutdown()
        cls.upstream.server_close()
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

    def test_the_crawler_files_are_the_apis_public_routes(self):
        for path, target in (('/robots.txt', '/api/public/robots.txt'), ('/sitemap.xml', '/api/public/sitemap.xml')):
            self.seen.clear()
            for requested in (path, path + '?x=1'):
                status, body, _ = self.get(requested)
                self.assertEqual((status, body), (200, 'upstream'), requested)
            self.assertEqual(self.seen, [('GET', target), ('GET', target + '?x=1')])

    def test_the_pokemon_prefixed_paths_are_proxied_to_the_gateway_like_every_api_path(self):
        # nginx sends /api/ to the gateway, which owns the /api/pokemon/ rewrite; the adapter passes the path through.
        self.seen.clear()
        for path in ('/api/pokemon/catalog/editions?q=a', '/api/catalog/editions?q=a', '/api/pokemon/want-list'):
            self.assertEqual(self.get(path)[:2], (200, 'upstream'), path)
        self.assertEqual(self.seen, [('GET', '/api/pokemon/catalog/editions?q=a'), ('GET', '/api/catalog/editions?q=a'),
                                     ('GET', '/api/pokemon/want-list')])

    def test_collection_import_starts_pass_a_body_over_64k_with_the_location_unchanged_on_both_paths(self):
        # The adapter enforces no body limit (nginx and the gateway do); the old and the /api/pokemon start routes
        # must both carry a payload between nginx's default 64k and 5 MiB, query intact, to the auth bundle.
        payload = b'Quantity,Name\n' + b'1,Starmie\n' * 100_000
        self.assertTrue(64 * 1024 < len(payload) < 5 * 1024 * 1024)
        self.seen.clear()
        self.bodies.clear()
        for path in ('/api/collection-imports', '/api/pokemon/collection-imports'):
            request = urllib.request.Request(f'http://127.0.0.1:{self.server.server_port}{path}?location_id=leaf-1',
                                             data=payload, method='POST', headers={'Content-Type': 'text/csv'})
            with urllib.request.urlopen(request, timeout=10) as response:
                self.assertEqual(response.status, 200)
        self.assertEqual(self.seen, [('POST', '/api/collection-imports?location_id=leaf-1'),
                                     ('POST', '/api/pokemon/collection-imports?location_id=leaf-1')])
        self.assertEqual(self.bodies, [payload, payload])

    def test_the_crawler_files_take_get_only_and_nothing_else_changes(self):
        self.seen.clear()
        request = urllib.request.Request(f'http://127.0.0.1:{self.server.server_port}/robots.txt', data=b'x', method='POST')
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(request, timeout=10)
        caught.exception.close()
        self.assertEqual(caught.exception.code, 405)
        self.assertEqual(self.seen, [])
        self.assertEqual(self.get('/definitely-not-a-route')[:2], (200, '<html>app'))
        self.assertEqual(self.get('/scan.html')[0], 404)


if __name__ == '__main__':
    unittest.main()
