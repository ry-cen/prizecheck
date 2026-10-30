"""What a deployed host still needs from its operator: `python -m app.host_readiness`.

The host script's readiness report (`prizecheck-deploy.sh readiness`, also the end of `setup`) runs this in the current API
image once a release is deployed. It reads and prints; it writes nothing and always exits 0, because these steps come after
the first deploy and must never fail `setup`. It prints one line per item, `ok`, `missing` or `warning`, and under each
unfinished item the next step:

  owner bound, catalog rules applied (a deploy applies them, ADR 0021), active catalog generation, last price import, scanner index,
  last catalog check, signup mode.

A database that cannot be read, or that answers too slowly (15 s a statement, 5 s on a lock), prints one `warning` line and
nothing else. The session is read-only.

Environment set by the host script: READINESS_SIGNUP_MODE (SIGNUP_MODE from the env file, read on the host: the database
does not hold it), READINESS_SCRIPT (how the operator runs the host script), READINESS_GUIDE (the deployment guide).
"""
import sys

from app.core.ops.readiness import run
from app.games.pokemon.ops.readiness import items


def owner(conn, report, script):
    if conn.execute("SELECT 1 FROM owner_binding").fetchone():
        report.ok("The owner is bound")
        return True
    report.missing(
        "No owner is bound",
        "sign in once with the OWNER_EMAIL account, then find the account id: "
        f"{script} compose exec db psql -U prizecheck -d prizecheck -c 'select id, email from \"user\";'",
        f"bind it: {script} tool /app/scripts/bind_owner.py 'ID'",
    )
    return False


def main(out=None, environ=None) -> int:
    return run(out, environ, owner=owner, items=items)


if __name__ == "__main__":
    sys.exit(main())
