"""Cooperative, per-user host admission for local Prizecheck work (Linux only).

Two API reservations, at most two workers each; every other task is exclusive.
Active/crashed reservations are never expired. Status and recovery do not signal processes.
This is not a sandbox: legacy commands and processes that daemonize require coordination.
"""
import argparse
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import secrets
import signal
import subprocess
import sys
import time

STATE = Path.home() / '.local/state/prizecheck-admission-v1'
SIGNALS = (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)


def reset_sigchld():
    """Own our child statuses even when the launcher ignored SIGCHLD."""
    signal.signal(signal.SIGCHLD, signal.SIG_DFL)


def identity(pid):
    """Boot id + Linux start ticks: PID reuse and reboot cannot impersonate an owner. None means absent."""
    try:
        stat = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()
        return Path('/proc/sys/kernel/random/boot_id').read_text().strip() + ':' + stat[19]
    except FileNotFoundError:
        return None


def group_alive(pgid):
    try:
        os.killpg(pgid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


class Registry:
    def __init__(self, directory=STATE):
        if sys.platform != 'linux':
            raise RuntimeError('Local admission requires Linux /proc; use coordinated exclusive legacy runs on other hosts')
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        if self.directory.is_symlink() or self.directory.stat().st_uid != os.getuid():
            raise RuntimeError('Admission directory must be owned by this user and cannot be a symlink')

    @contextmanager
    def transaction(self):
        # Never replace/unlink the lock inode. State is atomically replaced under flock.
        with (self.directory / 'lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            path = self.directory / 'state.json'
            state = json.loads(path.read_text()) if path.exists() else {'sequence': 0, 'requests': []}
            yield state
            temp = self.directory / 'state.new'
            with temp.open('w') as stream:
                json.dump(state, stream, indent=2)
                stream.flush()
                os.fsync(stream.fileno())
            temp.replace(path)
            fd = os.open(self.directory, os.O_DIRECTORY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)

    def enqueue(self, root, mode, workers=0):
        if mode not in ('api', 'exclusive') or (mode == 'api' and workers not in (1, 2)):
            raise ValueError('API admission needs 1 or 2 workers')
        token = secrets.token_hex(12)
        if identity(os.getpid()) is None:
            raise RuntimeError('Cannot establish admission owner identity')
        with self.transaction() as state:
            state['sequence'] += 1
            state['requests'].append(dict(token=token, sequence=state['sequence'], root=str(Path(root).resolve()),
                                          mode=mode, workers=workers, pid=os.getpid(), identity=identity(os.getpid()),
                                          status='waiting', created=time.time(), child=None))
        return token

    def admit(self, token):
        with self.transaction() as state:
            # Only provably dead waiters disappear automatically. Uncertain/active owners remain blockers.
            state['requests'][:] = [r for r in state['requests'] if r['status'] != 'waiting'
                                     or identity(r['pid']) == r['identity']]
            request = next(r for r in state['requests'] if r['token'] == token)
            active = [r for r in state['requests'] if r['status'] != 'waiting']
            for owner in active:
                if identity(owner['pid']) != owner['identity']:
                    owner.update(status='retained', reason='Owner exited without verified release; audit all owned resources')
            earlier = [r for r in state['requests'] if r['status'] == 'waiting' and r['sequence'] < request['sequence']]
            if any(r['root'] == request['root'] for r in active):
                return False
            if request['mode'] == 'exclusive':
                ready = not active and not earlier
            else:
                ready = (len(active) < 2 and all(r['mode'] == 'api' and r['status'] == 'active' for r in active)
                         and not any(r['mode'] == 'exclusive' for r in earlier)
                         and len(earlier) < 2 - len(active))
            if ready:
                request['status'] = 'active'
            return ready

    def update(self, token, **values):
        with self.transaction() as state:
            next(r for r in state['requests'] if r['token'] == token).update(values)

    def remove(self, token):
        with self.transaction() as state:
            state['requests'][:] = [r for r in state['requests'] if r['token'] != token]

    def snapshot(self):
        with self.transaction() as state:
            return [dict(r, owner_alive=identity(r['pid']) == r['identity']) for r in state['requests']]

    def recover(self, token, verified):
        with self.transaction() as state:
            request = next(r for r in state['requests'] if r['token'] == token)
            if not verified or identity(request['pid']) == request['identity']:
                raise RuntimeError('Recovery requires a dead owner and --cleanup-verified after an independent resource audit')
            if request['child'] and group_alive(request['child']):
                raise RuntimeError('Recorded child process group still exists; reservation retained')
            state['requests'].remove(request)


@contextmanager
def reservation(registry, root, mode, workers=0):
    token = registry.enqueue(root, mode, workers)
    admitted = False
    try:
        print(f'Admission queued: {token} {mode} ({registry.directory})', flush=True)
        while not registry.admit(token):
            time.sleep(.2)
        admitted = True
        print(f'Admission active: {token} {mode}', flush=True)
        yield token
    finally:
        if not admitted:
            registry.remove(token)
        # Caller releases explicitly after cleanup proof. Exceptions/crashes retain active reservations.


def supervise(command, registry, token, env=None, cwd=None):
    """Forward interrupts to our child, then wait for its cleanup. Repeated interrupts never skip the wait."""
    process = None
    interrupted = None
    registered = False
    delivered = False

    def deliver():
        nonlocal delivered
        if registered and interrupted is not None and not delivered:
            delivered = True
            if process.poll() is None:
                process.send_signal(interrupted)  # Our unreaped child cannot have a reused PID.

    def forward(signum, frame):
        nonlocal interrupted
        interrupted = interrupted or signum
        deliver()

    previous = {s: signal.signal(s, forward) for s in SIGNALS}
    try:
        # The handler defers forwarding until durable registration; no blocked mask leaks into fork/exec.
        # SIGKILL at any point still leaves the active reservation for an independent cleanup audit.
        process = subprocess.Popen(command, env=env, cwd=cwd, start_new_session=True)
        registry.update(token, child=process.pid, child_identity=identity(process.pid))
        registered = True
        deliver()
        code = process.wait()
        return (128 + interrupted if interrupted else code), not group_alive(process.pid)
    finally:
        for s, handler in previous.items():
            signal.signal(s, handler)


def main(argv=None):
    reset_sigchld()
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='operation', required=True)
    sub.add_parser('status')
    recover = sub.add_parser('recover')
    recover.add_argument('token')
    recover.add_argument('--cleanup-verified', action='store_true')
    execute = sub.add_parser('exec')
    execute.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    registry = Registry()
    if args.operation == 'status':
        print(json.dumps(registry.snapshot(), indent=2))
        return 0
    if args.operation == 'recover':
        registry.recover(args.token, args.cleanup_verified)
        return 0
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    if not command:
        parser.error('exec requires a foreground command after --')
    root = Path.cwd().resolve()
    for name in ('node_modules', '.venv'):
        if (root / name).is_symlink():
            parser.error(f'{name} must belong physically to this checkout')
    temp = root / '.scratch/tmp'
    temp.mkdir(parents=True, exist_ok=True)
    if temp.resolve() != temp:
        parser.error('TMPDIR must belong physically to this checkout')
    with reservation(registry, root, 'exclusive') as token:
        code, empty = supervise(command, registry, token, env=dict(os.environ, TMPDIR=str(temp)), cwd=root)
        if empty:
            registry.remove(token)
        else:
            registry.update(token, status='retained', reason='Child process group still exists; audit cleanup before recovery')
            print(f'RETAINED admission: {token}', file=sys.stderr)
            return code or 1
        return code


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, ValueError) as error:
        print(f'admission: {error}', file=sys.stderr)
        raise SystemExit(1)
