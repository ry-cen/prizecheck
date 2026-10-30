"""The host readiness report's frame (`python -m app.host_readiness`): the line format, the read-only session and the
signup line. The game passes its items in; the composition is in ``app.host_readiness``.

``run`` opens one read-only session (15 s a statement, 5 s on a lock), runs ``owner`` and then ``items`` on it, and prints
the signup line. A database that cannot be read, or that answers too slowly, prints one `warning` line and nothing else.
It always returns 0.
"""
import os
import sys
from datetime import datetime, timedelta, timezone

import psycopg

from app.db import connect

# A price import or catalog check that has recorded no outcome after this long did not finish (a crash or a kill).
UNFINISHED_AFTER = timedelta(hours=6)


def age(moment, now):
    """A short age such as '5 minutes ago' for a timestamp."""
    seconds = max(0, int((now - moment).total_seconds()))
    for unit, size in (("day", 86400), ("hour", 3600), ("minute", 60)):
        if seconds >= size:
            count = seconds // size
            return f"{count} {unit}{'s' if count != 1 else ''} ago"
    return "just now"


class Report:
    def __init__(self, out):
        self.out = out

    def line(self, status, text, *next_steps):
        self.out.write(f"{status:<8} {text}\n")
        for step in next_steps:
            self.out.write(f"         next: {step}\n")

    def ok(self, text):
        self.line("ok", text)

    def missing(self, text, *next_steps):
        self.line("missing", text, *next_steps)

    def warning(self, text, *next_steps):
        self.line("warning", text, *next_steps)


def signup(report, mode, guide):
    if mode == "owner-only" and guide.endswith("deployment-oracle.md"):
        report.ok(f"Signup mode: owner-only (to open it, follow 'Opening signup' in {guide})")
    elif mode:
        report.ok(f"Signup mode: {mode}")
    else:
        report.warning("Signup mode: unknown (the host script did not pass SIGNUP_MODE)")


def run(out=None, environ=None, *, owner, items) -> int:
    """``owner(conn, report, script)`` reports the owner binding and returns whether it is bound;
    ``items(conn, report, *, now, script, guide, bound)`` reports the game's items, in order."""
    out = out or sys.stdout
    env = os.environ if environ is None else environ
    script = env.get("READINESS_SCRIPT") or "prizecheck-deploy.sh"
    guide = env.get("READINESS_GUIDE") or "the deployment guide"
    report = Report(out)
    now = datetime.now(timezone.utc)
    try:
        with connect(connect_timeout=10, options="-c statement_timeout=15000 -c lock_timeout=5000") as conn:
            conn.read_only = True
            bound = owner(conn, report, script)
            items(conn, report, now=now, script=script, guide=guide, bound=bound)
    except psycopg.Error as error:
        # Only the error's class: a message can carry the connection string.
        report.warning(f"Could not read the database ({type(error).__name__}); the app's state is unknown",
                       f"{script} status")
        return 0
    signup(report, env.get("READINESS_SIGNUP_MODE", ""), guide)
    return 0
