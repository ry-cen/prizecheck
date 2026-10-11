"""Initialize or upgrade ONLY the shared public records store; never recovers data.

Safe for an existing install: it never touches the publication/discovery
manifest. It creates an absent records store, upgrades an empty legacy
(format-1) records store, and is a no-op for an established store. It refuses
(exit status 1) when established records are missing or corrupt, or when a
legacy store holds records: restore those from backup rather than resetting.
"""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'api'))
from app.public_projection import ProjectionUnavailable, public_record_store  # noqa: E402


def main():
    try:
        public_record_store().initialize(deadline=time.monotonic() + 30)
    except ProjectionUnavailable:
        print('Shared public records are unavailable or established state is missing/corrupt; '
              'restore from backup instead of initializing.', file=sys.stderr)
        return 1
    print('Shared public records initialized')
    return 0


if __name__ == '__main__':
    sys.exit(main())
