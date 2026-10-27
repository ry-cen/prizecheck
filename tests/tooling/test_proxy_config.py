"""The deploy proxy's body limits (deploy/docker/nginx.conf): 64k for every request but Collection Import's start route,
which alone gets 5m in its own exact location (spec "Gateway and proxy"). That location must forward exactly as the
/api and /auth location does, identity-header strips included, since nginx doesn't share proxy directives between
sibling locations.

The same file's static-delivery rules for the card scanner (spec "Web and delivery"): the scanner document alone is
cross-origin isolated, /assets/ and its nested .mjs location send COEP, .mjs and .wasm are served right and gzipped,
and /scanner/m/ serves the pinned models immutably. nginx shares no add_header, if or try_files with a nested location,
so each is checked where it must be repeated."""
from pathlib import Path
import re
import unittest

# Comments dropped: they hold semicolons and braces.
CONFIG = re.sub(r'#.*', '', (Path(__file__).resolve().parents[2]/'deploy/docker/nginx.conf').read_text())
# The method guards (`if (...) { return 405; }`) are blocks too; they are checked on their own (starts_with_guard).
PLAIN = re.sub(r'\bif \([^\n]*?\) \{[^{}]*\}', '', CONFIG)
DIRECTIVE = re.compile(r'^\s*([a-z0-9_]+)\s+([^;{}]*);', re.MULTILINE)
START = 'location = /api/collection-imports {'
GATEWAY = 'location ~ ^/(api|auth)/ {'


def block(opening):
    """The directives directly inside the location that `opening` starts, as (name, value) pairs in order."""
    start = PLAIN.index(opening) + len(opening)
    depth, end = 1, start
    while depth:
        depth += {'{': 1, '}': -1}.get(PLAIN[end], 0)
        end += 1
    body = PLAIN[start:end - 1]
    if '{' in body:
        raise AssertionError(f'{opening} holds a nested block')
    return [(name, value.strip()) for name, value in DIRECTIVE.findall(body)]


def own_directives(opening):
    """Like block(), but for a location that holds nested locations: the nested blocks are left out."""
    start = PLAIN.index(opening) + len(opening)
    depth, end, own = 1, start, ''
    while depth:
        char = PLAIN[end]
        depth += {'{': 1, '}': -1}.get(char, 0)
        if depth == 1 and char != '{':
            own += char
        elif depth == 2 and char == '{':
            own = own[:own.rfind(';') + 1] if ';' in own else ''
        end += 1
    return [(name, value.strip()) for name, value in DIRECTIVE.findall(own)]


def starts_with_guard(opening):
    """The location refuses everything but GET and HEAD, as its first directive."""
    return CONFIG[CONFIG.index(opening) + len(opening):].lstrip().startswith(GUARD)


def headers(directives):
    return {value.split()[0]: value for name, value in directives if name == 'add_header'}


SCANNER = 'location = /collection/scan {'
MODELS = 'location ^~ /scanner/m/ {'
ASSETS = 'location /assets/ {'
MJS = 'location ~* \\.mjs$ {'
FALLBACK = 'location / {'
GUARD = 'if ($request_method !~ ^(GET|HEAD)$) { return 405; }'
ISOLATION = ('Cross-Origin-Opener-Policy', 'Cross-Origin-Embedder-Policy')
SECURITY = {'X-Content-Type-Options': 'X-Content-Type-Options nosniff always',
            'X-Frame-Options': 'X-Frame-Options DENY always'}
COEP = 'Cross-Origin-Embedder-Policy "require-corp" always'


class ProxyConfigTest(unittest.TestCase):
    def test_only_the_collection_import_start_route_takes_more_than_64k(self):
        sizes = [value.strip() for name, value in DIRECTIVE.findall(CONFIG) if name == 'client_max_body_size']
        self.assertEqual(sizes, ['64k', '5m'])
        self.assertIn(('client_max_body_size', '5m'), block(START))
        self.assertEqual(CONFIG.count(START), 1)

    def test_the_start_route_forwards_as_the_gateway_location_does(self):
        start = [directive for directive in block(START) if directive[0] != 'client_max_body_size']
        self.assertEqual(start, block(GATEWAY))
        self.assertIn(('proxy_pass', '$gateway'), start)
        for opening in (START, GATEWAY):
            self.assertNotIn('add_header', [name for name, _ in block(opening)])
        self.assertIn(('proxy_set_header', 'X-Internal-User ""'), start)

    def test_assets_mjs_served_as_javascript(self):
        mjs = block(MJS)
        self.assertIn(('default_type', 'text/javascript'), mjs)
        self.assertIn(('try_files', '$uri =404'), mjs)
        for opening in (ASSETS, MJS, MODELS, SCANNER, FALLBACK):
            self.assertTrue(starts_with_guard(opening), opening)
        # Nested inside /assets/, which does not share its directives with it.
        self.assertLess(CONFIG.index(ASSETS), CONFIG.index(MJS))
        self.assertLess(CONFIG.index(MJS), CONFIG.index(FALLBACK))
        self.assertEqual(headers(mjs), {**SECURITY, 'Cache-Control': 'Cache-Control "public, max-age=31536000, immutable" always',
                                        'Cross-Origin-Embedder-Policy': COEP})
        self.assertIn(('gzip_types', 'text/javascript'), mjs)

    def test_no_types_block_replaces_the_mime_map(self):
        self.assertIsNone(re.search(r'\btypes\s*\{', CONFIG))

    def test_assets_gzip_wasm(self):
        assets = own_directives(ASSETS)
        self.assertIn(('gzip', 'on'), assets)
        self.assertIn(('gzip_types', 'application/wasm'), assets)
        self.assertIn(('gzip_vary', 'on'), assets)
        self.assertIn(('gzip_vary', 'on'), block(MJS))
        self.assertIn(('try_files', '$uri =404'), assets)
        self.assertEqual(headers(assets)['Cache-Control'], 'Cache-Control "public, max-age=31536000, immutable" always')

    def test_the_models_location_serves_pinned_files_immutably_and_gzipped(self):
        models = block(MODELS)
        self.assertIn(('try_files', '$uri =404'), models)
        self.assertIn(('gzip', 'on'), models)
        types = dict(models)['gzip_types'].split()
        self.assertEqual(sorted(types), ['application/octet-stream', 'text/plain'])
        # No `always` on Cache-Control here, so a 404 is not cached for a year; the security headers keep it.
        self.assertEqual(headers(models), {**SECURITY, 'Cache-Control': 'Cache-Control "public, max-age=31536000, immutable"'})

    def test_the_scanner_location_sends_coop_and_coep(self):
        scanner = block(SCANNER)
        self.assertIn(('try_files', '/scan.html =404'), scanner)
        self.assertEqual(headers(scanner), {**SECURITY, 'Cache-Control': 'Cache-Control "no-cache" always',
                                            'Cross-Origin-Opener-Policy': 'Cross-Origin-Opener-Policy "same-origin" always',
                                            'Cross-Origin-Embedder-Policy': COEP})
        self.assertEqual(CONFIG.count(SCANNER), 1)

    def test_no_other_html_document_gets_coop_or_coep(self):
        # Server level, the SPA fallback (every other document) and the other locations: neither isolation header.
        server = re.sub(r'location[^{]*\{(?:[^{}]|\{[^{}]*\})*\}', '', PLAIN)
        self.assertEqual(CONFIG.count('Cross-Origin-Opener-Policy'), 1)
        for name in ISOLATION:
            self.assertNotIn(name, server)
        self.assertEqual(headers(block(FALLBACK)).keys() & set(ISOLATION), set())
        self.assertEqual(headers(block(GATEWAY)).keys() & set(ISOLATION), set())
        self.assertEqual(headers(block(MODELS)).keys() & set(ISOLATION), set())
        self.assertIn(('try_files', '$uri /index.html'), block(FALLBACK))

    def test_the_scanner_entry_is_not_served_by_its_file_name(self):
        self.assertIn(('return', '404'), own_directives('location = /scan.html {'))

    def test_assets_and_the_nested_mjs_location_send_coep(self):
        self.assertEqual(headers(own_directives(ASSETS))['Cross-Origin-Embedder-Policy'], COEP)
        self.assertEqual(headers(block(MJS))['Cross-Origin-Embedder-Policy'], COEP)
        self.assertNotIn('Cross-Origin-Opener-Policy', headers(own_directives(ASSETS)))
        self.assertNotIn('Cross-Origin-Opener-Policy', headers(block(MJS)))

    def test_the_gateway_gets_the_client_address_from_nginx(self):
        for opening in (START, GATEWAY):
            self.assertIn(('proxy_set_header', 'X-Real-IP $remote_addr'), block(opening))
            self.assertIn(('proxy_set_header', 'X-Forwarded-For ""'), block(opening))
        self.assertNotIn('X-Real-IP ""', CONFIG)

    def test_only_the_prod_edge_gateway_may_set_the_client_address(self):
        server = re.sub(r'location[^{]*\{(?:[^{}]|\{[^{}]*\})*\}', '', PLAIN)
        directives = DIRECTIVE.findall(server)
        self.assertEqual([value.strip() for name, value in directives if name == 'set_real_ip_from'], ['10.201.80.1'])
        self.assertIn(('real_ip_header', 'X-Real-IP'), [(name, value.strip()) for name, value in directives])
        self.assertEqual(CONFIG.count('set_real_ip_from'), 1)
        self.assertNotIn('real_ip_recursive', CONFIG)


if __name__ == '__main__':
    unittest.main()
