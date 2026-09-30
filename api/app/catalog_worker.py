"""Run as a separate replaceable process: python -m app.catalog_worker.

Only an owner API request creates a run. Polling here never schedules a pull.
"""
import logging
import time

from app.catalog import claim_run, execute_run
from app.main import connect

logging.basicConfig(level=logging.INFO)
logging.getLogger("httpx").setLevel(logging.WARNING)


def main():
    while True:
        try:
            with connect() as conn:
                run_id = claim_run(conn)
                if run_id:
                    try:
                        execute_run(conn, run_id)
                    except Exception:
                        logging.exception("Catalog run %s failed", run_id)
                    continue
        except Exception:
            logging.exception("Catalog worker unavailable")
        time.sleep(5)


if __name__ == "__main__":
    main()
