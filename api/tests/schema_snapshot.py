"""Normalized definitions of a database's schema objects, read from pg_catalog, for the core baseline proof (S10, IM-13).

``snapshot`` returns ``{"<kind>:<name>": "<normalized definition>"}`` for the public schema's tables (with their columns),
constraints, indexes, sequences, views, functions and triggers. It reads pg_catalog and uses the server's own
``pg_get_*def`` printers, not pg_dump, so it runs against whatever server the tests use. The same schema built by
different migration histories gives the same snapshot; ``public.`` is dropped so a name never depends on search_path.
Constraint names, column order, defaults and function bodies are all part of a definition.

Nothing but ``rows_digest`` reads rows: it is the data half, one digest per table.
"""
import hashlib
import re

QUALIFIER = re.compile(r"\bpublic\.")


def normalize(text):
    return QUALIFIER.sub("", text)


RELATIONS = """
SELECT c.oid, c.relname, c.relkind, c.reloptions, c.relrowsecurity, c.relforcerowsecurity, c.relpersistence
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
ORDER BY c.relname"""

COLUMNS = """
SELECT a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull, pg_get_expr(d.adbin, d.adrelid),
       a.attidentity, a.attgenerated, coll.collname, a.attstorage, a.attcompression
FROM pg_attribute a
LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
LEFT JOIN pg_collation coll ON coll.oid = a.attcollation AND a.attcollation <> (SELECT oid FROM pg_collation WHERE collname = 'default')
WHERE a.attrelid = %s AND a.attnum > 0 AND NOT a.attisdropped
ORDER BY a.attnum"""

CONSTRAINTS = """
SELECT conname, contype, pg_get_constraintdef(oid), condeferrable, condeferred, convalidated,
       confrelid::regclass::text
FROM pg_constraint WHERE conrelid = %s ORDER BY conname"""

INDEXES = """
SELECT i.relname, pg_get_indexdef(i.oid)
FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
WHERE x.indrelid = %s ORDER BY i.relname"""

SEQUENCES = """
SELECT format_type(s.seqtypid, NULL), s.seqstart, s.seqincrement, s.seqmax, s.seqmin, s.seqcache, s.seqcycle,
       (SELECT d.refobjid::regclass::text || '.' || a.attname
          FROM pg_depend d JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
         WHERE d.objid = s.seqrelid AND d.classid = 'pg_class'::regclass AND d.refclassid = 'pg_class'::regclass
           AND d.deptype IN ('a', 'i'))
FROM pg_sequence s WHERE s.seqrelid = %s"""

FUNCTIONS = """
SELECT p.proname, pg_get_function_identity_arguments(p.oid), pg_get_functiondef(p.oid)
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p')
ORDER BY p.proname, pg_get_function_identity_arguments(p.oid)"""

TRIGGERS = """
SELECT t.tgname, c.relname, pg_get_triggerdef(t.oid)
FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND NOT t.tgisinternal ORDER BY c.relname, t.tgname"""

EXTENSIONS = "SELECT extname FROM pg_extension ORDER BY extname"
USER_TYPES = """
SELECT t.typname, t.typtype FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE n.nspname = 'public' AND t.typtype IN ('e', 'd', 'r', 'm') ORDER BY t.typname"""
POLICIES = "SELECT tablename, policyname, cmd, qual, with_check FROM pg_policies WHERE schemaname = 'public' ORDER BY 1, 2"


def snapshot(conn):
    """``{"table:holding": ..., "column:holding.id": ..., "constraint:holding.holding_pkey": ..., ...}``."""
    out = {}
    for oid, name, kind, options, rls, force_rls, persistence in conn.execute(RELATIONS).fetchall():
        if kind in ("r", "p"):
            out[f"table:{name}"] = normalize(f"kind={kind} options={options} rls={rls}/{force_rls} persistence={persistence}")
            for column in conn.execute(COLUMNS, (oid,)).fetchall():
                out[f"column:{name}.{column[0]}"] = normalize(repr(column[1:]))
            for conname, contype, definition, deferrable, deferred, validated, target in conn.execute(CONSTRAINTS, (oid,)).fetchall():
                out[f"constraint:{name}.{conname}"] = normalize(f"{contype} {definition} deferrable={deferrable}/{deferred} validated={validated}")
            for index_name, definition in conn.execute(INDEXES, (oid,)).fetchall():
                out[f"index:{index_name}"] = normalize(definition)
        elif kind in ("v", "m"):
            out[f"view:{name}"] = normalize(f"kind={kind} options={options} " + conn.execute("SELECT pg_get_viewdef(%s, true)", (oid,)).fetchone()[0])
            for column in conn.execute(COLUMNS, (oid,)).fetchall():
                out[f"column:{name}.{column[0]}"] = normalize(repr(column[1:3]))
            for index_name, definition in conn.execute(INDEXES, (oid,)).fetchall():
                out[f"index:{index_name}"] = normalize(definition)
        elif kind == "S":
            out[f"sequence:{name}"] = normalize(repr(conn.execute(SEQUENCES, (oid,)).fetchone()))
    for name, arguments, definition in conn.execute(FUNCTIONS).fetchall():
        out[f"function:{name}({arguments})"] = normalize(definition)
    for name, table, definition in conn.execute(TRIGGERS).fetchall():
        out[f"trigger:{table}.{name}"] = normalize(definition)
    for (name,) in conn.execute(EXTENSIONS).fetchall():
        out[f"extension:{name}"] = ""
    for name, typtype in conn.execute(USER_TYPES).fetchall():
        out[f"type:{name}"] = typtype
    for policy in conn.execute(POLICIES).fetchall():
        out[f"policy:{policy[0]}.{policy[1]}"] = normalize(repr(policy[2:]))
    return out


def foreign_keys(conn):
    """``[(table, constraint, referenced table)]`` for every foreign key in the public schema."""
    return [tuple(row) for row in conn.execute(
        "SELECT c.conrelid::regclass::text, c.conname, c.confrelid::regclass::text FROM pg_constraint c"
        " JOIN pg_namespace n ON n.oid = c.connamespace WHERE c.contype = 'f' AND n.nspname = 'public' ORDER BY 1, 2")]


def relation_names(conn):
    """The public schema's tables and views, by name."""
    return [row[0] for row in conn.execute(
        "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace"
        " WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm') ORDER BY 1")]


def rows_digest(conn, table):
    """``(row count, sha256)`` of the table's rows, each as the text PostgreSQL prints for the row, in that text's order. It
    does not depend on the order the rows were inserted in."""
    digest = hashlib.sha256()
    count = 0
    for (row,) in conn.execute(f'SELECT t::text FROM "{table}" t ORDER BY 1'):
        digest.update(row.encode("utf-8"))
        digest.update(b"\n")
        count += 1
    return count, digest.hexdigest()
