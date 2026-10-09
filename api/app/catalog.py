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


# Review identity deliberately excludes mutable lookup and quote information.
# Descriptor correspondence remains unchanged until the target-datastore preflight.
MUTABLE_SOURCE_KEYS = frozenset(("variantId", "pricing", "card_pricing", "cardmarket", "tcgplayer", "thirdParty", "tcgOnline"))
PHYSICAL_VARIANT_KEYS = frozenset(("finish", "type", "subtype", "size", "stamp", "stamps", "foil", "foilPattern"))


def physical_review_evidence(value):
    if isinstance(value, dict):
        return {key: physical_review_evidence(item) for key, item in value.items()
                if key not in MUTABLE_SOURCE_KEYS}
    if isinstance(value, list):
        return [physical_review_evidence(item) for item in value]
    return value


def marketplace_candidates(value):
    """Keep lookup identifiers separate from the changing quote payload."""
    if isinstance(value, dict):
        result = {}
        for key, item in value.items():
            if key in ("variantId", "thirdParty", "productId"):
                result[key] = item
            elif isinstance(item, (dict, list)):
                nested = marketplace_candidates(item)
                if nested:
                    result[key] = nested
        return result
    if isinstance(value, list):
        return [marketplace_candidates(item) for item in value]
    return {}


def source_metadata(record):
    variants = record.get("variants_detailed")
    variants = variants if isinstance(variants, list) else []
    return {
        "source_record": record,
        "unknown_fields": {"record": {key: value for key, value in record.items()
                         if key not in MUTABLE_SOURCE_KEYS and key not in
                         ("id", "name", "set", "localId", "image", "category", "energyType", "variants", "variants_detailed",
                          "regulationMark", "rarity", "illustrator", "dexId", "hp", "types", "evolveFrom", "stage", "suffix",
                          "item", "abilities", "attacks", "weaknesses", "resistances", "retreat", "legal", "description")},
                           "variants": [
            {key: value for key, value in item.items()
             if key not in PHYSICAL_VARIANT_KEYS and key not in MUTABLE_SOURCE_KEYS}
            if isinstance(item, dict) else {"unclassified": item}
            for item in variants]},
        "export_candidate": {key: record[key] for key in
                             ("name", "category", "energyType", "set", "localId", "regulationMark") if key in record},
    }


def variant_descriptors(record: dict) -> tuple[list[dict], bool]:
    detailed = record.get("variants_detailed")
    if detailed is not None:
        if not isinstance(detailed, list):
            return [{"kind": "unspecified", "label": "Unspecified Variant"}], True
        descriptors = []
        unclassified = False
        for item in detailed:
            if not isinstance(item, dict):
                return [{"kind": "unspecified", "label": "Unspecified Variant"}], True
            if any(key not in PHYSICAL_VARIANT_KEYS and key not in MUTABLE_SOURCE_KEYS for key in item):
                unclassified = True
            # Existing descriptor correspondence stays intact until preflight.
            descriptor = {key: value for key, value in item.items()
                          if key not in ("variantId", "pricing", "cardmarket", "tcgplayer") and value is not None}
            if not descriptor:
                return [{"kind": "unspecified", "label": "Unspecified Variant"}], True
            if isinstance(descriptor.get("stamps"), list):
                descriptor["stamps"] = sorted(descriptor["stamps"], key=lambda value: json.dumps(value, sort_keys=True))
            descriptors.append(descriptor)
        keys = [json.dumps(value, sort_keys=True) for value in descriptors]
        if len(keys) != len(set(keys)):
            raise CatalogError("Descriptor collision requires review before promotion")
        if descriptors:
            return descriptors, unclassified
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
        "ambiguous": ambiguous, "basic_energy": basic, "fingerprint": fingerprint(physical_review_evidence(record)),
        "metadata": source_metadata(record),
    }


def store_source_metadata(conn, printing_id, record, physical_conflict=False):
    """Retain source candidates without approving a physical or target match."""
    metadata = source_metadata(record)
    conn.execute("""INSERT INTO catalog_printing_metadata
      (printing_id,source_record,unknown_fields,export_candidate)
      VALUES (%s,%s,%s,%s) ON CONFLICT(printing_id) DO UPDATE SET
      source_record=EXCLUDED.source_record,unknown_fields=EXCLUDED.unknown_fields,
      export_candidate=EXCLUDED.export_candidate,
      live_revision=catalog_printing_metadata.live_revision+
        CASE WHEN catalog_printing_metadata.export_candidate IS DISTINCT FROM EXCLUDED.export_candidate THEN 1 ELSE 0 END,
      live_verified=CASE WHEN catalog_printing_metadata.export_candidate IS DISTINCT FROM EXCLUDED.export_candidate
        THEN false ELSE catalog_printing_metadata.live_verified END,
      live_quarantined=catalog_printing_metadata.live_quarantined OR
        catalog_printing_metadata.export_candidate IS DISTINCT FROM EXCLUDED.export_candidate,
      updated_at=now()""", (printing_id, json.dumps(record), json.dumps(metadata['unknown_fields']),
                            json.dumps(metadata['export_candidate'])))
    detailed = record.get('variants_detailed')
    detailed = detailed if isinstance(detailed, list) else []
    editions = conn.execute('SELECT id,descriptor FROM catalog_edition WHERE printing_id=%s', (printing_id,)).fetchall()
    for edition in editions:
        # Match only the existing exact descriptor. No cleaned keys, aliases,
        # product-ID correspondence or ambiguous record selection is permitted.
        exact = []
        for variant in detailed:
            if isinstance(variant, dict):
                descriptor = {key: value for key, value in variant.items()
                              if key not in ('variantId', 'pricing', 'cardmarket', 'tcgplayer') and value is not None}
                if isinstance(descriptor.get('stamps'), list):
                    descriptor['stamps'] = sorted(descriptor['stamps'], key=lambda value: json.dumps(value, sort_keys=True))
                if descriptor == edition['descriptor']:
                    exact.append(variant)
        variant = exact[0] if len(exact) == 1 else {}
        unresolved = physical_conflict or bool(detailed) and len(exact) != 1
        mapping = marketplace_candidates(variant if variant else record)
        # Unresolved candidates remain review evidence, never eligible metadata.
        mapping = {'candidate': mapping, 'correspondence': 'unresolved' if unresolved else 'source_candidate',
                   'physical_evidence': {key: physical_review_evidence(record[key]) for key in ('id', 'name', 'set', 'localId', 'variants') if key in record},
                   'variant_evidence': physical_review_evidence(variant)}
        quote = variant.get('pricing', record.get('pricing', {}))
        unknown = {key: value for key, value in variant.items()
                   if key not in PHYSICAL_VARIANT_KEYS and key not in MUTABLE_SOURCE_KEYS}
        conn.execute("""INSERT INTO catalog_edition_metadata
          (edition_id,mapping_candidate,quote_candidate,source_variant,unknown_fields,mapping_quarantined)
          VALUES (%s,%s,%s,%s,%s,%s) ON CONFLICT(edition_id) DO UPDATE SET
          mapping_candidate=EXCLUDED.mapping_candidate,quote_candidate=EXCLUDED.quote_candidate,
          source_variant=EXCLUDED.source_variant,unknown_fields=EXCLUDED.unknown_fields,
          mapping_revision=catalog_edition_metadata.mapping_revision+
            CASE WHEN catalog_edition_metadata.mapping_candidate IS DISTINCT FROM EXCLUDED.mapping_candidate THEN 1 ELSE 0 END,
          mapping_verified=CASE WHEN catalog_edition_metadata.mapping_candidate IS DISTINCT FROM EXCLUDED.mapping_candidate
            OR EXCLUDED.mapping_quarantined THEN false ELSE catalog_edition_metadata.mapping_verified END,
          mapping_quarantined=catalog_edition_metadata.mapping_quarantined OR EXCLUDED.mapping_quarantined OR
            catalog_edition_metadata.mapping_candidate IS DISTINCT FROM EXCLUDED.mapping_candidate,
          updated_at=now()""", (edition['id'], json.dumps(mapping), json.dumps(quote), json.dumps(variant),
                                json.dumps(unknown), unresolved))


def _progress(conn, run_id: UUID, phase: str, **counts):
    fields = ["phase = %s", "lease_until = now() + interval '2 minutes'"]
    values = [phase]
    for key, value in counts.items():
        fields.append(f"{key} = %s")
        values.append(value)
    conn.execute(f"UPDATE catalog_run SET {', '.join(fields)} WHERE id = %s", (*values, run_id))
    conn.commit()


class RunnerBusy(CatalogError):
    pass


def claim_run(conn, run_id: UUID) -> UUID | None:
    # The session lock outlives progress commits and publication transactions.
    if not conn.execute("SELECT pg_try_advisory_lock(914703) AS acquired").fetchone()["acquired"]:
        conn.rollback()
        raise RunnerBusy("Catalog importer already running")
    conn.commit()
    with conn.transaction():
        row = conn.execute("""SELECT id FROM catalog_run WHERE id=%s AND outcome IS NULL
          AND phase='queued' FOR UPDATE""", (run_id,)).fetchone()
        if not row:
            conn.execute("SELECT pg_advisory_unlock(914703)")
            return None
        conn.execute("UPDATE catalog_run SET phase='enumerating', lease_until=now()+interval '2 minutes' WHERE id=%s", (run_id,))
    return run_id


def execute_run(conn, run_id: UUID, source=None, before_promotion=None):
    try:
        source = source or TCGdexSource()
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
                    if not isinstance(records[source_id], dict) or records[source_id].get("id") != source_id:
                        raise CatalogError("Full record source ID mismatch")
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
        previous_ids={row['source_id'] for row in conn.execute("""SELECT gp.source_id
          FROM catalog_generation_printing gp JOIN catalog_printing p ON p.id=gp.printing_id
          WHERE gp.generation_id=(SELECT active_generation FROM catalog_state WHERE singleton)
            AND p.source='tcgdex' AND NOT gp.tombstoned""").fetchall()}
        if previous_ids and len(previous_ids-first)>len(previous_ids)*0.01:
            raise CatalogError('English source ID count dropped by more than 1%')
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
                candidate=dict(item)
                # Historical reviews used raw-payload hashes. Reuse their key
                # only when preserved candidate evidence proves the exact same
                # physical discrepancy, including retained/rejected decisions;
                # no descriptor/reference rewrite occurs.
                physical_candidate = physical_review_evidence({key: value for key, value in candidate.items()
                                                               if key not in ('metadata', 'fingerprint', 'manual_printing_ids', 'manual_printings')})
                prior_reviews = conn.execute("SELECT candidate,source_fingerprint FROM catalog_review WHERE source_id=%s ORDER BY created_at,id", (source_id,)).fetchall()
                for review in prior_reviews:
                    prior_candidate = physical_review_evidence({key: value for key, value in review['candidate'].items()
                                                                if key not in ('metadata', 'fingerprint', 'manual_printing_ids', 'manual_printings')})
                    if prior_candidate == physical_candidate:
                        item['fingerprint'] = review['source_fingerprint']
                        break
                if old_id and not conn.execute('SELECT 1 FROM catalog_source_reference WHERE source_id=%s',(source_id,)).fetchone():
                    matches=conn.execute("""SELECT gp.printing_id,gp.display_name,gp.set_name,gp.collector_number FROM catalog_generation_printing gp
                      JOIN catalog_printing p ON p.id=gp.printing_id WHERE gp.generation_id=%s
                      AND p.source='manual' AND lower(gp.set_id)=lower(%s) AND lower(gp.collector_number)=lower(%s)""",
                      (old_id,item['set_id'],item['collector_number'])).fetchall()
                    if matches:
                        match_candidate={**candidate,'manual_printing_ids':[str(row['printing_id']) for row in matches],
                          'manual_printings':[{'id':str(row['printing_id']),'name':row['display_name'],'set_name':row['set_name'],'collector_number':row['collector_number']} for row in matches]}
                        conn.execute("""INSERT INTO catalog_review(printing_id,source_id,kind,source_fingerprint,detail,candidate)
                          VALUES (%s,%s,'source_match',%s,'Possible match to a reviewed manual Printing; physical confirmation required',%s)
                          ON CONFLICT DO NOTHING""",(existing['printing_id'] if existing else None,source_id,item['fingerprint'],json.dumps(match_candidate)))
                if existing:
                    established = conn.execute("SELECT * FROM catalog_printing_display WHERE printing_id=%s",
                                               (existing['printing_id'],)).fetchone()
                    if established and (established['set_id'] != item['set_id'] or
                                        established['collector_number'] != item['collector_number']):
                        conn.execute("""INSERT INTO catalog_review(printing_id,source_id,kind,source_fingerprint,detail,candidate)
                          VALUES (%s,%s,'reference_change',%s,'Source set or collector number changed; physical Printing review required',%s)
                          ON CONFLICT DO NOTHING""", (existing['printing_id'],source_id,item['fingerprint'],json.dumps(candidate)))
                        for field in ('set_id','set_name','collector_number','image_url'):
                            item[field] = established[field]
                        item['basic_energy'] = existing['basic_energy']
                        # A recycled source reference cannot create Editions on
                        # the established physical Printing while review is pending.
                        item['ambiguous'] = True
                if existing and existing["display_name"] != item["name"]:
                    item["name"] = existing["display_name"]
                    item["search_name"] = existing["search_name"]
                    conn.execute("""INSERT INTO catalog_review(printing_id,source_id,kind,source_fingerprint,detail)
                      VALUES (%s,%s,'name_change',%s,'Source name changed; identity review required') ON CONFLICT DO NOTHING""",
                      (existing["printing_id"], source_id, item["fingerprint"]))
                    conn.execute("UPDATE catalog_review SET candidate=%s WHERE source_id=%s AND kind='name_change' AND source_fingerprint=%s",(json.dumps(candidate),source_id,item['fingerprint']))
                if existing and old_id:
                    old_descriptors={json.dumps(r['descriptor'],sort_keys=True) for r in conn.execute("""SELECT e.descriptor
                      FROM catalog_generation_edition ge JOIN catalog_edition e ON e.id=ge.edition_id
                      WHERE ge.generation_id=%s AND ge.printing_id=%s AND ge.active
                        AND NOT EXISTS (SELECT 1 FROM catalog_override co WHERE co.edition_id=e.id)""",(old_id,existing['printing_id'])).fetchall()}
                    new_descriptors={json.dumps(d,sort_keys=True) for d in item['descriptors']}
                    if old_descriptors-new_descriptors:item['ambiguous']=True
                if item["ambiguous"]:
                    conn.execute("""INSERT INTO catalog_review(printing_id,source_id,kind,source_fingerprint,detail)
                      VALUES (%s,%s,'variant_ambiguity',%s,'Variant flags require review') ON CONFLICT DO NOTHING""",
                      (existing["printing_id"] if existing else None, source_id, item["fingerprint"]))
                    conn.execute("UPDATE catalog_review SET candidate=%s WHERE source_id=%s AND kind='variant_ambiguity' AND source_fingerprint=%s",(json.dumps(candidate),source_id,item['fingerprint']))
                identity_id = existing["identity_id"] if existing else conn.execute("""INSERT INTO catalog_identity(identity_key,display_name)
                  VALUES (%s,%s) ON CONFLICT(identity_key) DO UPDATE SET identity_key=EXCLUDED.identity_key RETURNING id""",
                  (item["identity_key"], item["name"])).fetchone()["id"]
                printing_id = conn.execute("""INSERT INTO catalog_printing(source,source_id,identity_id)
                  VALUES ('tcgdex',%s,%s) ON CONFLICT(source_id) DO UPDATE SET source_id=EXCLUDED.source_id RETURNING id""",
                  (source_id, identity_id)).fetchone()["id"]
                conn.execute("UPDATE catalog_review SET printing_id=%s WHERE source_id=%s AND source_fingerprint=%s AND printing_id IS NULL",(printing_id,source_id,item['fingerprint']))
                conn.execute("""INSERT INTO catalog_generation_printing
                  (generation_id,printing_id,source_id,set_id,set_name,collector_number,display_name,search_name,image_url,source_fingerprint,basic_energy)
                  VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                  (run_id, printing_id, source_id, item["set_id"], item["set_name"], item["collector_number"],
                   item["name"], item["search_name"], item["image_url"], item["fingerprint"], item["basic_energy"]))
                if item['ambiguous'] and existing:
                    # Pending physical ambiguity cannot withdraw established Editions.
                    conn.execute("""INSERT INTO catalog_generation_edition(generation_id,edition_id,printing_id,active)
                      SELECT %s,edition_id,printing_id,active FROM catalog_generation_edition
                      WHERE generation_id=%s AND printing_id=%s ON CONFLICT DO NOTHING""",
                      (run_id,old_id,printing_id))
                    item['descriptors']=[]
                if not existing and any(item['metadata']['unknown_fields']['variants']):
                    # Unknown physical facets are retained in review/source data,
                    # never admitted automatically into a new Edition identity.
                    item['descriptors'] = [{"kind": "unspecified", "label": "Unspecified Variant"}]
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
                physical_conflict = item['ambiguous'] or bool(existing and (
                    candidate['name'] != item['name'] or candidate['set_id'] != item['set_id'] or
                    candidate['collector_number'] != item['collector_number']))
                store_source_metadata(conn, printing_id, records[source_id], physical_conflict)
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
            conn.execute("""UPDATE catalog_generation_edition ge SET active=false
              FROM catalog_edition_replacement er WHERE ge.generation_id=%s AND ge.edition_id=er.edition_id""",(run_id,))
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
    except BaseException as exc:
        conn.rollback()
        safe = str(exc) if isinstance(exc, CatalogError) else "Catalog import failed; start a new pull"
        conn.execute("UPDATE catalog_run SET phase='failed', outcome='failed', error=%s, finished_at=now(), lease_until=NULL WHERE id=%s AND outcome IS NULL", (safe[:180], run_id))
        conn.commit()
        raise
    finally:
        try:
            if isinstance(source, TCGdexSource):
                source.client.close()
        finally:
            if not conn.closed:
                conn.rollback()
                conn.execute("SELECT pg_advisory_unlock(914703)")
                conn.commit()
