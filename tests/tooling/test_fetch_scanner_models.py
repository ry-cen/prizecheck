"""scripts/fetch-scanner-models.mjs and web/scanner-models.lock.json. No real model is downloaded: the script reads a
stub directory when SCANNER_MODELS_STUB_DIR is set, and the fixtures here are a few bytes long."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / 'scripts/fetch-scanner-models.mjs'
REVISION = '0123456789abcdef0123456789abcdef01234567'
FILES = {'embedder': ('embed.onnx', b'embedder bytes'), 'ocr-recognizer': ('rec.onnx', b'recognizer bytes'),
         'ocr-dictionary': ('dict.txt', b'a\nb\n')}


def lock_for(files=FILES, host='huggingface.co'):
    return {'family': 'dinov2s-int8', 'preprocessing': 1, 'files': [
        {'role': role, 'name': name, 'url': f'https://{host}/o/r/resolve/{REVISION}/{name}', 'bytes': len(data),
         'sha256': hashlib.sha256(data).hexdigest()} for role, (name, data) in files.items()]}


def run(*args, stub=None):
    env = {**os.environ}
    env.pop('SCANNER_MODELS_STUB_DIR', None)
    if stub:
        env['SCANNER_MODELS_STUB_DIR'] = str(stub)
    return subprocess.run(['node', str(SCRIPT), *args], capture_output=True, text=True, env=env, timeout=60)


class FetchScannerModelsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.dir = Path(self.temp.name)
        self.addCleanup(self.temp.cleanup)
        self.stub = self.dir / 'stub'
        self.stub.mkdir()
        for name, data in FILES.values():
            (self.stub / name).write_bytes(data)
        self.out = self.dir / 'm'
        self.models_ts = self.dir / 'models.ts'

    def write_lock(self, lock):
        path = self.dir / 'lock.json'
        path.write_text(json.dumps(lock))
        return str(path)

    def fetch(self, lock, stub=True):
        return run('--lock', self.write_lock(lock), '--out', str(self.out), stub=self.stub if stub else None)

    def test_it_writes_each_file_under_its_sha_prefix(self):
        result = self.fetch(lock_for())
        self.assertEqual(result.returncode, 0, result.stderr)
        for entry in lock_for()['files']:
            written = self.out / entry['sha256'][:16] / entry['name']
            self.assertEqual(hashlib.sha256(written.read_bytes()).hexdigest(), entry['sha256'])
        self.assertEqual(result.stdout.count('fetched:'), 3)
        self.assertEqual(sorted(path.name for path in self.out.rglob('*.partial')), [])

    def test_a_verified_file_is_not_fetched_again(self):
        self.fetch(lock_for())
        for name, _ in FILES.values():
            (self.stub / name).unlink()
        result = self.fetch(lock_for())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.count('present:'), 3)

    def test_a_wrong_hash_fails_and_leaves_nothing(self):
        (self.stub / 'rec.onnx').write_bytes(b'recognizer bytez')
        result = self.fetch(lock_for())
        self.assertEqual(result.returncode, 1)
        self.assertIn('sha256 does not match', result.stderr)
        self.assertEqual([path for path in self.out.rglob('rec.onnx*')], [])

    def test_a_wrong_length_fails(self):
        (self.stub / 'dict.txt').write_bytes(b'a\nb\nextra\n')
        result = self.fetch(lock_for())
        self.assertEqual(result.returncode, 1)
        self.assertIn('more than the expected 4 bytes', result.stderr)
        self.assertEqual([path for path in self.out.rglob('dict.txt*')], [])

    def test_a_short_file_fails(self):
        (self.stub / 'dict.txt').write_bytes(b'a\n')
        result = self.fetch(lock_for())
        self.assertEqual(result.returncode, 1)
        self.assertIn('expected 4 bytes, got 2', result.stderr)

    def test_a_corrupt_file_on_disk_is_replaced(self):
        self.fetch(lock_for())
        victim = next(self.out.rglob('rec.onnx'))
        victim.write_bytes(b'corrupt')
        self.assertEqual(self.fetch(lock_for()).returncode, 0)
        self.assertEqual(victim.read_bytes(), FILES['ocr-recognizer'][1])

    def test_only_huggingface_urls_are_accepted(self):
        for host in ('example.com', 'huggingface.co.evil.test', 'cdn.huggingface.co'):
            result = self.fetch(lock_for(host=host))
            self.assertEqual(result.returncode, 1, host)
            self.assertIn('https://huggingface.co/', result.stderr)
        lock = lock_for()
        lock['files'][0]['url'] = lock['files'][0]['url'].replace('https:', 'http:')
        self.assertEqual(self.fetch(lock).returncode, 1)
        self.assertFalse(self.out.exists())

    def test_an_unknown_role_is_rejected(self):
        lock = lock_for()
        lock['files'].append({**lock['files'][0], 'role': 'extra', 'name': 'other.onnx'})
        result = self.fetch(lock)
        self.assertEqual(result.returncode, 1)
        self.assertIn('unknown role extra', result.stderr)

    def test_the_output_directory_is_gitignored_and_kept_out_of_the_docker_context(self):
        ignored = subprocess.run(['git', 'check-ignore', '-q', 'web/public/scanner/m/c179f8f7f592449c/model.onnx'], cwd=ROOT)
        self.assertEqual(ignored.returncode, 0)
        self.assertIn('web/public/scanner/m/', (ROOT / '.dockerignore').read_text().splitlines())

    def test_unpinned_revisions_and_unsafe_names_are_rejected(self):
        lock = lock_for()
        lock['files'][0]['url'] = lock['files'][0]['url'].replace(REVISION, 'main')
        self.assertIn('revision', self.fetch(lock).stderr)
        lock = lock_for()
        lock['files'][0]['name'] = '../escape.onnx'
        self.assertIn('plain file name', self.fetch(lock).stderr)

    def test_check_passes_when_models_ts_agrees_and_fails_when_it_does_not(self):
        lock = self.write_lock(lock_for())
        wrote = run('--lock', lock, '--models-ts', str(self.models_ts), '--write')
        self.assertEqual(wrote.returncode, 0, wrote.stderr)
        self.assertEqual(run('--lock', lock, '--models-ts', str(self.models_ts), '--check').returncode, 0)
        self.models_ts.write_text(self.models_ts.read_text().replace('-p1', '-p2'))
        result = run('--lock', lock, '--models-ts', str(self.models_ts), '--check')
        self.assertEqual(result.returncode, 1)
        self.assertIn('disagrees with the lock file', result.stderr)
        self.models_ts.unlink()
        self.assertEqual(run('--lock', lock, '--models-ts', str(self.models_ts), '--check').returncode, 1)

    def test_the_real_lock_file_is_sound_and_matches_models_ts(self):
        result = run('--check')
        self.assertEqual(result.returncode, 0, result.stderr)
        lock = json.loads((ROOT / 'web/scanner-models.lock.json').read_text())
        embedder = next(entry for entry in lock['files'] if entry['role'] == 'embedder')
        self.assertEqual(embedder['sha256'], 'c179f8f7f592449c4c1bca4cd124a7538021428c5ffb89afde9503935b197efb')
        self.assertEqual(embedder['bytes'], 24446700)
        models = (ROOT / 'web/src/scanner/models.ts').read_text()
        self.assertIn('export const SCANNER_MODEL_ID = "dinov2s-int8-c179f8f7-p1";', models)

    def test_the_web_image_runs_the_fetch_before_the_build_and_the_check_runs_in_npm_check(self):
        dockerfile = (ROOT / 'deploy/docker/web.Dockerfile').read_text()
        self.assertLess(dockerfile.index('RUN node scripts/fetch-scanner-models.mjs'), dockerfile.index('RUN npx vite build'))
        self.assertIn('node scripts/fetch-scanner-models.mjs --check', json.loads((ROOT / 'package.json').read_text())['scripts']['check'])


if __name__ == '__main__':
    unittest.main()
