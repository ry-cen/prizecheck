"""Manual English catalog import. The worker is a replaceable process, not a timer."""
import gzip
import hashlib
import json
import os
import random
import re
import time
import unicodedata
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from urllib.parse import quote
from uuid import UUID

import httpx
import psycopg
from psycopg.rows import dict_row

BASE_URL = "https://api.tcgdex.net/v2/en/cards"
MAX_WORKERS = 8
MAX_CARDS = 100_000


class CatalogError(Exception):
    pass


def normalized_name(value: str) -> str:
    return " ".join(unicodedata.normalize("NFC", value).split())


def fingerprint(value: dict) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def variant_descriptors(record: dict) -> tuple[list[dict], bool]:
    detailed = record.get("variants_detailed")
    if detailed is not None:
        if not isinstance(detailed, list):
            return [{"kind": "unspecified", "label": "Unspecified Variant"}], True
        descriptors = []
        for item in detailed:
            if not isinstance(item, dict):
                return [{"kind": "unspecified", "label": "Unspecified Variant"}], True
            # Provider IDs and marketplace data are deliberately excluded from identity.
            descriptor = {key: value for key, value in item.items()
                          if key not in ("variantId", "pricing", "cardmarket", "tcgplayer") and value is not None}
            if not descriptor:
                return [{"kind": "unspecified", "label": "Unspecified Variant"}], True
            if isinstance(descriptor.get("stamps"), list):
                descriptor["stamps"] = sorted(descriptor["stamps"], key=lambda value: json.dumps(value, sort_keys=True))
            descriptors.append(descriptor)
        keys = [json.dumps(value, sort_keys=True) for value in descriptors]
        if len(keys) != len(set(keys)):
            return [{"kind": "unspecified", "label": "Unspecified Variant"}], True
        if descriptors:
            return descriptors, False
    variants = record.get("variants")
    if not isinstance(variants, dict):
        return [{"kind": "unspecified", "label": "Unspecified Variant"}], False
    finishes = [key for key in ("normal", "reverse", "holo") if variants.get(key) is True]
    ambiguous = any(value not in (True, False, None) for value in variants.values()) or any(
        variants.get(key) is True for key in ("firstEdition", "wPromo"))
    descriptors = [{"finish": value} for value in finishes]
    if not descriptors or ambiguous:
        descriptors.append({"kind": "unspecified", "label": "Unspecified Variant"})
    return descriptors, ambiguous


class TCGdexSource:
    def __init__(self):
        self.client = httpx.Client(timeout=20, follow_redirects=False,
                                   limits=httpx.Limits(max_connections=MAX_WORKERS, max_keepalive_connections=MAX_WORKERS))

    def _get(self, url: str):
        for attempt in range(12):
            try:
                response = self.client.get(url)
                response.raise_for_status()
                return response.json()
            except (httpx.TimeoutException, httpx.TransportError, httpx.HTTPStatusError) as exc:
                if attempt == 11 or isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code < 500 and exc.response.status_code != 429:
                    raise CatalogError("TCGdex request failed") from exc
                time.sleep(min(30, 2 ** attempt) + random.uniform(0, 0.5))
        raise CatalogError("TCGdex request failed")

    def enumerate(self) -> set[str]:
        data = self._get(BASE_URL)
        if not isinstance(data, list) or not data or len(data) > MAX_CARDS:
            raise CatalogError("Invalid English enumeration")
        ids = [item.get("id") for item in data if isinstance(item, dict)]
        if len(ids) != len(data) or any(not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_.!%~-]{1,128}", value) for value in ids):
            raise CatalogError("Invalid English source ID")
        if len(set(ids)) != len(ids):
            raise CatalogError("Duplicate English source ID")
        return set(ids)

    def fetch(self, source_id: str) -> dict:
        data = self._get(f"{BASE_URL}/{quote(source_id, safe='-._~')}")
        if not isinstance(data, dict) or data.get("id") != source_id:
            raise CatalogError("Full record source ID mismatch")
        return data


def normalize(record: dict) -> dict:
    source_id = record.get("id")
    set_data = record.get("set")
    name = record.get("name")
    number = record.get("localId")
    if (not isinstance(source_id, str) or not isinstance(set_data, dict)
            or not isinstance(set_data.get("id"), str) or not isinstance(set_data.get("name"), str)
            or not isinstance(name, str) or not normalized_name(name)
            or not isinstance(number, (str, int)) or not str(number).strip()):
        raise CatalogError("Invalid full card record")
    name = normalized_name(name)
    descriptors, ambiguous = variant_descriptors(record)
    category = record.get("category")
    energy_type = record.get("energyType")
    if category == "Energy" and energy_type in ("Normal", "Basic"):
        basic = "supported"
    elif category == "Energy" and energy_type == "Special":
        basic = "not_basic"
    elif category == "Energy":
        basic = "unresolved"
    else:
        basic = "not_basic"
    image = record.get("image")
    return {
        "source_id": source_id, "set_id": set_data["id"], "set_name": set_data["name"],
        "collector_number": str(number), "name": name, "identity_key": name,
        "search_name": name.casefold(), "image_url": image if isinstance(image, str) and image.startswith("https://") else None,
        "descriptors": descriptors,
        "ambiguous": ambiguous, "basic_energy": basic, "fingerprint": fingerprint(record),
    }


def _progress(conn, run_id: UUID, phase: str, **counts):
    fields = ["phase = %s", "lease_until = now() + interval '2 minutes'"]
    values = [phase]
    for key, value in counts.items():
        fields.append(f"{key} = %s")
        values.append(value)
    conn.execute(f"UPDATE catalog_run SET {', '.join(fields)} WHERE id = %s", (*values, run_id))
    conn.commit()


def claim_run(conn) -> UUID | None:
    # Session lock covers the entire network fetch and promotion. A crashed
    # worker releases it; a replacement can claim the expired lease.
    if not conn.execute("SELECT pg_try_advisory_lock(914703) AS acquired").fetchone()["acquired"]:
        return None
    conn.commit()
    with conn.transaction():
        row = conn.execute("""SELECT id FROM catalog_run WHERE outcome IS NULL
          AND (phase = 'queued' OR lease_until < now()) ORDER BY started_at FOR UPDATE SKIP LOCKED LIMIT 1""").fetchone()
        if not row:
            conn.execute("SELECT pg_advisory_unlock(914703)")
            return None
        run_id = row["id"]
        conn.execute("UPDATE catalog_run SET phase = 'enumerating', lease_until = now() + interval '2 minutes' WHERE id = %s", (run_id,))
    return run_id


def execute_run(conn, run_id: UUID, source=None, before_promotion=None):
    source = source or TCGdexSource()
    try:
        first = source.enumerate()
        _progress(conn, run_id, "fetching", enumerated_count=len(first))
        records = {}
        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
            remaining = iter(sorted(first))
            pending = {}
            for source_id in remaining:
                pending[pool.submit(source.fetch, source_id)] = source_id
                if len(pending) == MAX_WORKERS:
                    break
            while pending:
                done, _ = wait(pending, return_when=FIRST_COMPLETED)
                for future in done:
                    source_id = pending.pop(future)
                    records[source_id] = future.result()
                    if len(records) % 50 == 0:
                        _progress(conn, run_id, "fetching", fetched_count=len(records))
                    next_id = next(remaining, None)
                    if next_id is not None:
                        pending[pool.submit(source.fetch, next_id)] = next_id
        _progress(conn, run_id, "validating", fetched_count=len(records))
        second = source.enumerate()
        if first != second:
            raise CatalogError("English enumeration changed during the run")
        normalized = [normalize(records[source_id]) for source_id in sorted(first)]
        refs = [(item["set_id"], item["collector_number"]) for item in normalized]
        if len(set(refs)) != len(refs):
            raise CatalogError("Duplicate set and collector reference")
        previous = conn.execute("SELECT source_count FROM catalog_generation WHERE id = (SELECT active_generation FROM catalog_state WHERE singleton)").fetchone()
        if previous and len(first) < previous["source_count"] * 0.99:
            raise CatalogError("English source ID count dropped by more than 1%")
        raw = gzip.compress(json.dumps([records[key] for key in sorted(first)], ensure_ascii=False, separators=(",", ":")).encode(), mtime=0)
        limit = int(os.environ.get("CATALOG_RAW_MAX_BYTES", "100000000"))
        if len(raw) > limit:
            raise CatalogError("Raw generation exceeds configured capacity gate")
        _progress(conn, run_id, "promoting", validated_count=len(normalized))
        with conn.transaction():
            state = conn.execute("SELECT active_generation FROM catalog_state WHERE singleton FOR UPDATE").fetchone()
            old_id = state["active_generation"]
            conn.execute("INSERT INTO catalog_generation(id,source_count,raw_gzip,raw_sha256) VALUES (%s,%s,%s,%s)",
                         (run_id, len(first), raw, hashlib.sha256(raw).hexdigest()))
            if before_promotion:
                before_promotion()
            old = {}
            if old_id:
                old = {row["source_id"]: row for row in conn.execute(
                    "SELECT gp.*, p.identity_id FROM catalog_generation_printing gp JOIN catalog_printing p ON p.id=gp.printing_id WHERE gp.generation_id=%s", (old_id,)).fetchall()}
            for item in normalized:
                source_id = item["source_id"]
                existing = old.get(source_id)
                if existing and existing["display_name"] != item["name"]:
                    item["name"] = existing["display_name"]
                    item["search_name"] = existing["search_name"]
                    conn.execute("""INSERT INTO catalog_review(printing_id,source_id,kind,source_fingerprint,detail)
                      VALUES (%s,%s,'name_change',%s,'Source name changed; identity review required') ON CONFLICT DO NOTHING""",
                      (existing["printing_id"], source_id, item["fingerprint"]))
                if item["ambiguous"]:
                    conn.execute("""INSERT INTO catalog_review(printing_id,source_id,kind,source_fingerprint,detail)
                      VALUES (%s,%s,'variant_ambiguity',%s,'Variant flags require review') ON CONFLICT DO NOTHING""",
                      (existing["printing_id"] if existing else None, source_id, item["fingerprint"]))
                identity_id = existing["identity_id"] if existing else conn.execute("""INSERT INTO catalog_identity(identity_key,display_name)
                  VALUES (%s,%s) ON CONFLICT(identity_key) DO UPDATE SET identity_key=EXCLUDED.identity_key RETURNING id""",
                  (item["identity_key"], item["name"])).fetchone()["id"]
                printing_id = conn.execute("""INSERT INTO catalog_printing(source,source_id,identity_id)
                  VALUES ('tcgdex',%s,%s) ON CONFLICT(source_id) DO UPDATE SET source_id=EXCLUDED.source_id RETURNING id""",
                  (source_id, identity_id)).fetchone()["id"]
                conn.execute("""INSERT INTO catalog_generation_printing
                  (generation_id,printing_id,source_id,set_id,set_name,collector_number,display_name,search_name,image_url,source_fingerprint,basic_energy)
                  VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                  (run_id, printing_id, source_id, item["set_id"], item["set_name"], item["collector_number"],
                   item["name"], item["search_name"], item["image_url"], item["fingerprint"], item["basic_energy"]))
                for descriptor in item["descriptors"]:
                    descriptor_key = json.dumps(descriptor, sort_keys=True)
                    edition_id = conn.execute("""INSERT INTO catalog_edition(printing_id,descriptor_key,descriptor)
                      VALUES (%s,%s,%s) ON CONFLICT(printing_id,descriptor_key) DO UPDATE SET descriptor_key=EXCLUDED.descriptor_key RETURNING id""",
                      (printing_id, descriptor_key, json.dumps(descriptor))).fetchone()["id"]
                    conn.execute("INSERT INTO catalog_generation_edition(generation_id,edition_id,printing_id) VALUES (%s,%s,%s)",
                                 (run_id, edition_id, printing_id))
                if old_id:
                    conn.execute("""INSERT INTO catalog_generation_edition(generation_id,edition_id,printing_id,active)
                      SELECT %s,ge.edition_id,ge.printing_id,ge.active FROM catalog_generation_edition ge
                      JOIN catalog_override co ON co.edition_id=ge.edition_id AND co.action='approve_edition'
                      WHERE ge.generation_id=%s AND ge.printing_id=%s
                      ON CONFLICT(generation_id,edition_id) DO NOTHING""", (run_id, old_id, printing_id))
            for source_id, prior in old.items():
                if source_id not in first:
                    if source_id.startswith("manual:"):
                        # Owner-reviewed records remain active across full source pulls.
                        # Possible later source matches are a separate owner review.
                        conn.execute("""INSERT INTO catalog_generation_printing
                          (generation_id,printing_id,source_id,set_id,set_name,collector_number,display_name,search_name,image_url,source_fingerprint,basic_energy,tombstoned)
                          VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,false)""",
                          (run_id, prior["printing_id"], source_id, prior["set_id"], prior["set_name"], prior["collector_number"],
                           prior["display_name"], prior["search_name"], prior["image_url"], prior["source_fingerprint"], prior["basic_energy"]))
                        conn.execute("""INSERT INTO catalog_generation_edition(generation_id,edition_id,printing_id,active)
                          SELECT %s,edition_id,printing_id,active FROM catalog_generation_edition
                          WHERE generation_id=%s AND printing_id=%s""", (run_id, old_id, prior["printing_id"]))
                        continue
                    conn.execute("""INSERT INTO catalog_generation_printing
                      (generation_id,printing_id,source_id,set_id,set_name,collector_number,display_name,search_name,image_url,source_fingerprint,basic_energy,tombstoned)
                      VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,true)""",
                      (run_id, prior["printing_id"], source_id, prior["set_id"], prior["set_name"], prior["collector_number"],
                       prior["display_name"], prior["search_name"], prior["image_url"], prior["source_fingerprint"], prior["basic_energy"]))
                    conn.execute("""INSERT INTO catalog_generation_edition(generation_id,edition_id,printing_id,active)
                      SELECT %s,edition_id,printing_id,false FROM catalog_generation_edition WHERE generation_id=%s AND printing_id=%s""",
                      (run_id, old_id, prior["printing_id"]))
            conn.execute("UPDATE catalog_state SET active_generation=%s, revision=revision+1, last_success=now() WHERE singleton", (run_id,))
            conn.execute("UPDATE catalog_run SET phase='complete', outcome='succeeded', finished_at=now(), lease_until=NULL WHERE id=%s", (run_id,))
            # Keep current and previous successful compressed raw generations.
            conn.execute("""DELETE FROM catalog_generation WHERE id NOT IN (
              SELECT id FROM catalog_generation ORDER BY imported_at DESC LIMIT 2)""")
            db_limit = os.environ.get("CATALOG_DB_MAX_BYTES")
            if db_limit:
                database_bytes = conn.execute("SELECT pg_database_size(current_database()) AS size").fetchone()["size"]
                if database_bytes > int(db_limit):
                    raise CatalogError("Catalog exceeds configured database capacity gate")
    except Exception as exc:
        conn.rollback()
        safe = str(exc) if isinstance(exc, CatalogError) else "Catalog import failed; check worker logs"
        conn.execute("UPDATE catalog_run SET phase='failed', outcome='failed', error=%s, finished_at=now(), lease_until=NULL WHERE id=%s", (safe[:180], run_id))
        conn.commit()
        raise
    finally:
        if isinstance(source, TCGdexSource):
            source.client.close()
