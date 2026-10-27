"""PostgreSQL connections for the private API."""
import os

import psycopg
from psycopg.rows import dict_row


def connect(**options):
    return psycopg.connect(os.environ["DATABASE_URL"], row_factory=dict_row, **options)
