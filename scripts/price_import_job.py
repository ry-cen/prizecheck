"""Import the daily TCGCSV Pokemon price snapshot into PostgreSQL (ADR 0019, design section 4.2).

    python scripts/price_import_job.py [--force | --rebind-only]

Exit codes: 0 imported, unchanged, or another run holds the lock; 1 the database is unreachable; 2 failed; 3 partial.
--rebind-only skips the download and only rebinds prices (the data-repair step).
See api/app/price_import.py. Environment: DATABASE_URL; PRICE_IMPORT_CONTACT (else SCANNER_INDEX_CONTACT, else OWNER_EMAIL).
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'api'))
from app.price_import import main  # noqa: E402

if __name__ == '__main__':
    sys.exit(main())
