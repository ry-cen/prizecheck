"""Drop the databases of verification runs that were killed before their own cleanup; scripts/verify.py calls reap()
first, before it creates its own databases.

scripts/verify.py tags every database it creates (``tcg_verify_<16 hex>``, ``..._gw<i>`` per pytest-xdist worker and
``..._s<k>`` per extra browser stack) with an owner record in the database comment: the run id, a hashed id of this
host, the verify.py pid and that process's start time. reap() drops one run's databases, all of them or none, only when:

- at least one carries an owner record, every record names the same owner, and no comment is foreign;
- the owner ran on this host and its process has exited: no process has its pid, or the one that has it started at
  another time (the pid was reused);
- the owner record is at least MIN_AGE_S old;
- no session is connected to any of them, and DROP DATABASE (never WITH (FORCE)) finds none either.

Untagged databases (an older harness, or a run killed between CREATE DATABASE and COMMENT) and names under the prefix
that scripts/verify.py does not make are kept and reported. An advisory lock on the admin database serializes reaping
with creating and tagging, so a reaper never sees a database its creator has not tagged yet.
"""
from dataclasses import dataclass
import functools
import hashlib
import json
import math
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import time

import psycopg
from psycopg import sql

from verify_discard import RUN_ID

PREFIX = 'tcg_verify_'
TOOL = 'tcg-verify'
VERSION = 1
LOCK = 914790          # advisory lock key on the admin database; reaping and creating+tagging never interleave
MIN_AGE_S = 60         # an owner record younger than this is never reaped
HARNESS_NAME = re.compile(r'(tcg_verify_[0-9a-f]{16})(?:_gw\d+|_s\d+)?')  # scripts/verify.py database_names()
UNKNOWN = object()     # process_started() could not tell
CANDIDATES = """SELECT d.datname, shobj_description(d.oid, 'pg_database'),
                       (SELECT count(*) FROM pg_stat_activity a WHERE a.datid = d.oid)
                FROM pg_database d
                WHERE starts_with(d.datname, %s) AND d.datname <> current_database()
                ORDER BY d.datname"""


@dataclass(frozen=True)
class Owner:
    run: str
    host: str
    pid: int
    started: str | None
    created: float


@dataclass(frozen=True)
class Member:
    name: str
    comment: str | None
    sessions: int


@dataclass(frozen=True)
class Verdict:
    drop: bool
    reason: str


def _machine_id():
    for path in ('/etc/machine-id', '/var/lib/dbus/machine-id'):
        try:
            value = Path(path).read_text().strip()
        except OSError:
            continue
        if value:
            return value
    return ''


def _platform_uuid():
    try:
        shown = subprocess.run(['ioreg', '-rd1', '-c', 'IOPlatformExpertDevice'], capture_output=True, text=True,
                               timeout=10).stdout
    except (OSError, subprocess.SubprocessError):
        return ''
    match = re.search(r'"IOPlatformUUID" = "([^"]+)"', shown)
    return match[1] if match else ''


@functools.cache
def host_identity():
    """A hashed id of this host: the IOPlatformUUID on macOS (its hostname follows the network), /etc/machine-id with
    the hostname on Linux (containers can share an image's machine id, not a hostname), else the hostname alone."""
    if sys.platform == 'darwin':
        source = _platform_uuid()
    else:
        machine = _machine_id()
        source = machine + '\0' + socket.gethostname() if machine else ''
    if not source:
        source = 'hostname\0' + socket.gethostname()
    return hashlib.sha256(source.encode()).hexdigest()[:16]


def process_started(pid):
    """The start time ps shows for pid, None when no process has that pid, or UNKNOWN when ps cannot tell."""
    try:
        result = subprocess.run(['ps', '-o', 'lstart=', '-p', str(pid)], capture_output=True, text=True, timeout=10,
                                env={'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'LC_ALL': 'C', 'TZ': 'UTC'})
    except (OSError, subprocess.SubprocessError):
        return UNKNOWN
    shown = ' '.join(result.stdout.split())
    if result.returncode == 0 and shown:
        return shown
    if result.returncode == 1 and not shown and not result.stderr.strip():
        return None
    return UNKNOWN


def current_owner(run):
    """The owner record of this verify.py process for run."""
    pid = os.getpid()
    started = process_started(pid)
    return Owner(run, host_identity(), pid, started if isinstance(started, str) else None, round(time.time(), 3))


def owner_record(owner):
    """The database comment that names owner."""
    return json.dumps({'tool': TOOL, 'version': VERSION, 'run': owner.run, 'host': owner.host, 'pid': owner.pid,
                       'started': owner.started, 'created': owner.created}, sort_keys=True)


def parse_owner(comment):
    """The Owner in a database comment, or None when the comment is not an owner record of this version."""
    try:
        record = json.loads(comment)
    except (TypeError, ValueError):
        return None
    if not isinstance(record, dict) or record.get('tool') != TOOL or record.get('version') != VERSION:
        return None
    run, host, pid, started, created = (record.get(key) for key in ('run', 'host', 'pid', 'started', 'created'))
    if not (isinstance(run, str) and RUN_ID.fullmatch(run) and isinstance(host, str) and host
            and type(pid) is int and 1 < pid < 2 ** 22
            and (started is None or (isinstance(started, str) and started))
            and type(created) in (int, float) and math.isfinite(created)):
        return None
    return Owner(run, host, pid, started, float(created))


def owner_state(owner, probe=process_started):
    """'alive', 'dead' or 'unknown'. Dead only when no process has the pid, or the one that has it started at another
    time; anything ps cannot answer is 'unknown', which keeps the databases."""
    shown = probe(owner.pid)
    if shown is UNKNOWN:
        return 'unknown'
    if shown is None:
        return 'dead'
    if owner.started is not None and shown != owner.started:
        return 'dead'
    return 'alive'


def group_candidates(members):
    """({run's base database name: [its members]}, [members under the prefix that scripts/verify.py does not make])."""
    runs, strays = {}, []
    for member in members:
        match = HARNESS_NAME.fullmatch(member.name)
        if match:
            runs.setdefault(match[1], []).append(member)
        else:
            strays.append(member)
    return runs, strays


def decide(members, *, host, now, probe=process_started, min_age=MIN_AGE_S):
    """Whether to drop one run's databases (all of them or none), and why."""
    sessions = sum(member.sessions for member in members)
    if sessions:
        return Verdict(False, f'in use by {sessions} session(s)')
    owners = set()
    for member in members:
        if member.comment is None:
            continue
        owner = parse_owner(member.comment)
        if owner is None:
            return Verdict(False, f'{member.name} has a comment that is not an owner record; drop it by hand if it is a leak')
        owners.add(owner)
    if not owners:
        return Verdict(False, 'untagged: an older harness made it, or its run stopped while creating it; '
                              'drop it by hand once no gate uses it')
    if len({(owner.run, owner.host, owner.pid, owner.started) for owner in owners}) > 1:
        return Verdict(False, 'its owner records disagree; drop it by hand if it is a leak')
    owner = max(owners, key=lambda item: item.created)
    if owner.host != host:
        return Verdict(False, f'owner run {owner.run} ran on another host')
    age = now - owner.created
    if age < min_age:
        return Verdict(False, f'owner run {owner.run} tagged it {max(age, 0.0):.0f} s ago')
    state = owner_state(owner, probe)
    if state == 'alive':
        return Verdict(False, f'owner run {owner.run} (pid {owner.pid}) is still running')
    if state == 'unknown':
        return Verdict(False, f'could not tell whether owner run {owner.run} (pid {owner.pid}) is running')
    return Verdict(True, f'owner run {owner.run} (pid {owner.pid}) on this host has exited')


def create_databases(conn, names, owner, created):
    """CREATE DATABASE and tag each of names under the reaper lock, so no reaper sees one untagged. Each name is
    appended to created as soon as it exists, so the caller's cleanup drops it even when tagging fails."""
    record = owner_record(owner)
    conn.execute('SELECT pg_advisory_lock(%s)', (LOCK,))
    try:
        for database in names:
            conn.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(database)))
            created.append(database)
            # COMMENT is a utility statement: it takes no bind parameters, so the record goes in as a quoted literal.
            conn.execute(sql.SQL('COMMENT ON DATABASE {} IS {}').format(sql.Identifier(database), sql.Literal(record)))
    finally:
        if not conn.closed and not conn.broken:
            conn.execute('SELECT pg_advisory_unlock(%s)', (LOCK,))


def drop_if_unused(conn, database):
    """DROP DATABASE without FORCE: PostgreSQL refuses while any session is connected, so a session that arrived after
    the pg_stat_activity check keeps its database. None when dropped, else why it was kept."""
    try:
        conn.execute(sql.SQL('DROP DATABASE IF EXISTS {}').format(sql.Identifier(database)))
    except psycopg.errors.ObjectInUse:
        return 'a session connected before it could be dropped'
    except psycopg.Error as error:
        return f'DROP DATABASE failed ({type(error).__name__})'
    return None


def reap(admin_url, *, prefix=PREFIX, host=None, now=None, probe=process_started, min_age=MIN_AGE_S):
    """Drop the leaked databases of dead runs among those whose names start with prefix. Returns (report lines, dropped
    names). Never raises for a database or ps failure: the lines say what was skipped."""
    lines, dropped = [], []
    try:
        with psycopg.connect(admin_url, autocommit=True, connect_timeout=10) as conn:
            conn.execute("SET lock_timeout = '10s'")
            conn.execute('SELECT pg_advisory_lock(%s)', (LOCK,))
            members = [Member(name, comment, int(sessions)) for name, comment, sessions in conn.execute(CANDIDATES, (prefix,))]
            runs, strays = group_candidates(members)
            host = host_identity() if host is None else host
            now = time.time() if now is None else now
            for member in strays:
                lines.append(f'kept {member.name}: scripts/verify.py does not make that name')
            for base in sorted(runs):
                group = runs[base]
                verdict = decide(group, host=host, now=now, probe=probe, min_age=min_age)
                if not verdict.drop:
                    lines.append(f'kept {", ".join(member.name for member in group)}: {verdict.reason}')
                    continue
                # Untagged members first, so a failure part-way keeps a tagged member and the next run can decide again.
                for member in sorted(group, key=lambda item: (item.comment is not None, item.name)):
                    kept = drop_if_unused(conn, member.name)
                    if kept:
                        lines.append(f'kept {member.name}: {kept}')
                        break
                    dropped.append(member.name)
                    lines.append(f'dropped {member.name}: {verdict.reason}')
    except psycopg.errors.LockNotAvailable:
        lines.append('skipped: another verification run is creating or reaping databases')
    except psycopg.Error as error:
        lines.append(f'skipped: database error ({type(error).__name__})')
    return [f'== reaper: {line}' for line in lines or ['no leaked verification databases']], dropped
