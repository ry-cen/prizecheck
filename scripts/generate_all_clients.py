"""Write or check every generated TypeScript client in one run: ``python scripts/generate_all_clients.py [--check]``.

The emitters are ``scripts/generate_client.py`` and every ``scripts/generate_*_client.py``; each defines ``TARGET`` and
``render(openapi)`` (see ``scripts/client_generator.py``). The OpenAPI document is built once for all of them. With
``--check`` every stale file is reported before the run fails, so one run shows the whole list.
"""
import importlib
import sys
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))
import client_generator  # noqa: E402


def emitter_names():
    """The emitter module names, sorted: generate_client plus every generate_<domain>_client."""
    paths = [SCRIPTS / "generate_client.py", *SCRIPTS.glob("generate_*_client.py")]
    return sorted(path.stem for path in paths)


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    check = "--check" in argv
    openapi = client_generator.load_openapi()
    problems = []
    for name in emitter_names():
        problem = client_generator.write_or_check(importlib.import_module(name), openapi, check)
        if problem:
            problems.append(problem)
    if problems:
        raise SystemExit("\n".join(problems))


if __name__ == "__main__":
    main()
