"""Riftbound's own PostgreSQL connection. It reads RIFTBOUND_DATABASE_URL and never DATABASE_URL (ADR 0023)."""
import os

import psycopg
from psycopg.rows import dict_row


def connect(**options):
    """Open a connection when called, so building the app touches no database."""
    return psycopg.connect(os.environ["RIFTBOUND_DATABASE_URL"], row_factory=dict_row, **options)
