"""Import the daily TCGCSV Pokemon price snapshot into PostgreSQL (ADR 0019, design section 4.2).

    python scripts/price_import_job.py [--force] [--rematch] | --rebind-only

Exit codes: 0 imported, unchanged, or another run holds the lock; 1 the database is unreachable; 2 failed; 3 partial.
--rebind-only skips the download and only rebinds prices (the data-repair step).
--rematch then re-evaluates the unverified rule_failed Editions of the reviewed promo sets under the active matching
rule (promos TCGCSV listed after the activation); it runs after an import that ended 0 or 3, rebinds when it verified
any Edition, and changes no exit code.
It first finishes or applies the release's catalog rules (ADR 0021), so the import sees the new mappings.
See api/app/price_import.py. Environment: DATABASE_URL; PRICE_IMPORT_CONTACT (else SCANNER_INDEX_CONTACT, else OWNER_EMAIL).
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'api'))
from app.games.pokemon.prices.price_import import main  # noqa: E402
from app.games.pokemon.catalog.rule_rollout import resume  # noqa: E402

if __name__ == '__main__':
    resume()
    sys.exit(main())
