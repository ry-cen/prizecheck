"""Real manifest HTTP relay and application HTTP/PostgreSQL contracts."""
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import time
from uuid import uuid4
import threading
import pytest
from test_holdings import fixture, add, client
from test_decks import create
from test_publications import command
from test_discovery import visibility

@pytest.fixture
def relay(monkeypatch, tmp_path):
    state = {'format':1,'revision':0,'decks':{}}
    guard = threading.Lock()
    controls = {'collide':True,'failed':False,'weak':False,'requests':0,'put_failed':False,'hang':False}
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args): pass
        def do_GET(self):
            if controls['hang']:
                time.sleep(6);return
            with guard:
                controls['requests'] += 1
                assert self.headers['Authorization'] == 'Bearer projection-test-secret'
                assert self.headers['Cache-Control'] == 'no-cache, no-store'
                self.send_response(503 if controls['failed'] else 200)
                self.send_header('ETag', ('W/' if controls['weak'] else '')+'"'+str(state['revision'])+'"')
                self.end_headers(); self.wfile.write(json.dumps(state).encode())
        def do_PUT(self):
            nonlocal state
            updated = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            with guard:
                if controls['put_failed']:
                    self.send_response(503);self.end_headers();return
                if controls['collide']:
                    controls['collide'] = False
                    self.send_response(412); self.end_headers(); return
                if self.headers.get('If-Match') != '"'+str(state['revision'])+'"':
                    self.send_response(412); self.end_headers(); return
                assert updated['revision'] == state['revision']+1
                state = updated
                self.send_response(204); self.end_headers()
    server = ThreadingHTTPServer(('127.0.0.1',0),Handler)
    thread = threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    monkeypatch.setenv('PUBLIC_PROJECTION_ADAPTER','http')
    monkeypatch.setenv('PUBLIC_PROJECTION_URL',f'http://127.0.0.1:{server.server_port}/manifest')
    monkeypatch.setenv('PUBLIC_PROJECTION_TOKEN','projection-test-secret')
    monkeypatch.setenv('PUBLIC_PROJECTION_DIR',str(tmp_path))
    yield controls
    server.shutdown();server.server_close();thread.join()

def test_http_manifest_publication_cas_revoke_discovery_and_no_private_database(relay,monkeypatch):
    owner,_,_,_,edition,_ = fixture()
    deck = create(owner).json()['location']['id'];add(owner,deck,edition,'4')
    published = command(owner,deck)
    assert published.status_code == 200,published.text
    token = published.json()['token']
    assert relay['collide'] is False
    assert visibility(owner,deck,'listed').status_code == 200
    assert client.get('/api/public/discovery').json()['decks'][0]['total'] == '4'
    database = os.environ['DATABASE_URL']
    monkeypatch.setenv('DATABASE_URL','postgresql://unreachable:1/private')
    assert client.get('/api/public/decks/'+token).json()['total'] == '4'
    assert client.get('/api/public/discovery').status_code == 200
    monkeypatch.setenv('DATABASE_URL',database)
    assert command(owner,deck,'DELETE').status_code == 200
    assert client.get('/api/public/decks/'+token).status_code == 404
    assert client.get('/api/public/discovery').json()['decks'] == []
    relay['failed'] = True
    assert client.get('/api/public/decks/'+token).status_code == 503

def test_concurrent_http_writers_preserve_both_decks_and_ordered_revocation(relay):
    owner,other,_,_,edition,_ = fixture()
    first = create(owner).json()['location']['id'];second = create(other).json()['location']['id']
    add(owner,first,edition,'3');add(other,second,edition,'5')
    with ThreadPoolExecutor(2) as workers:
        results = list(workers.map(lambda pair:command(*pair),[(owner,first),(other,second)]))
    assert [result.status_code for result in results] == [200,200]
    one,two = [result.json()['token'] for result in results]
    assert client.get('/api/public/decks/'+one).json()['total'] == '3'
    assert client.get('/api/public/decks/'+two).json()['total'] == '5'
    assert visibility(owner,first,'listed').status_code == 200
    assert visibility(other,second,'listed').status_code == 200
    with ThreadPoolExecutor(2) as workers:
        update = workers.submit(command,owner,first,'PUT','Updated remote title')
        revoke = workers.submit(command,other,second,'DELETE')
        assert update.result().status_code == revoke.result().status_code == 200
    assert client.get('/api/public/decks/'+two).status_code == 404
    assert client.get('/api/public/decks/'+one).json()['title'] == 'Updated remote title'
    assert [deck['title'] for deck in client.get('/api/public/discovery').json()['decks']] == ['Updated remote title']

def test_weak_etag_fails_closed_before_publication(relay):
    relay['weak'] = True
    assert client.get('/api/public/discovery').status_code == 503
    assert relay['collide'] is True


def test_failed_http_write_retries_durable_command_without_new_token(relay):
    owner,_,_,_,edition,_ = fixture()
    deck = create(owner).json()['location']['id'];add(owner,deck,edition,'2')
    key = uuid4();relay['put_failed'] = True
    assert command(owner,deck,key=key).status_code == 503
    relay['put_failed'] = False
    resumed = command(owner,deck,key=key)
    assert resumed.status_code == 200
    token = resumed.json()['token']
    assert command(owner,deck,key=key).json() == resumed.json()
    assert client.get('/api/public/decks/'+token).json()['total'] == '2'


@pytest.mark.slow(reason='wall-clock: waits out a hanging manifest relay')
def test_http_manifest_timeout_is_safe_unavailable(relay):
    relay['hang'] = True
    response = client.get('/api/public/discovery')
    assert response.status_code == 503
    assert 'projection-test-secret' not in response.text
