"""The deploy proxy's body limits (deploy/docker/nginx.conf): 64k for every request but Collection Import's start route,
which alone gets 5m in its own exact location (spec "Gateway and proxy"). That location must forward exactly as the
/api and /auth location does, identity-header strips included, since nginx doesn't share proxy directives between
sibling locations."""
from pathlib import Path
import re
import unittest

# Comments dropped: they hold semicolons and braces.
CONFIG = re.sub(r'#.*', '', (Path(__file__).resolve().parents[2]/'deploy/docker/nginx.conf').read_text())
DIRECTIVE = re.compile(r'^\s*([a-z0-9_]+)\s+([^;{}]*);', re.MULTILINE)
START = 'location = /api/collection-imports {'
GATEWAY = 'location ~ ^/(api|auth)/ {'


def block(opening):
    """The directives directly inside the location that `opening` starts, as (name, value) pairs in order."""
    start = CONFIG.index(opening) + len(opening)
    depth, end = 1, start
    while depth:
        depth += {'{': 1, '}': -1}.get(CONFIG[end], 0)
        end += 1
    body = CONFIG[start:end - 1]
    if '{' in body:
        raise AssertionError(f'{opening} holds a nested block')
    return [(name, value.strip()) for name, value in DIRECTIVE.findall(body)]


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


if __name__ == '__main__':
    unittest.main()
