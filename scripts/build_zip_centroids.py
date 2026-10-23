"""Generate migrations/146_zip_centroids.sql from the pinned Census and GeoNames zip code files.

Run it by hand, with the network, only to build or verify migration 146:

    .venv/bin/python -I scripts/build_zip_centroids.py --print-hashes   # download, print hashes and counts, write nothing
    .venv/bin/python -I scripts/build_zip_centroids.py                  # write migrations/146_zip_centroids.sql
    .venv/bin/python -I scripts/build_zip_centroids.py --check          # exit 1 when the file differs from a rebuild

The downloads are untrusted data. They are cached under .scratch/zip-centroids/ (gitignored), checked against the
sha256 pins below, and read in memory: no archive is ever extracted to disk. The script uses the standard library only.
Nothing from the sources reaches the SQL except validated digits, quantized decimals and two fixed source names.

The output may never change once it reaches dev (scripts/release.py). GeoNames republishes US.zip daily, so a changed
hash means the source moved on; a refresh is a new migration, with new pins. It is never run by npm run check.

Exit codes: 0 done (or up to date), 1 a download, hash or data check failed, or --check found the file stale.
"""
import argparse
import csv
import hashlib
import io
import os
import re
import sys
import tempfile
import urllib.request
import zipfile
from decimal import ROUND_HALF_EVEN, Decimal, InvalidOperation
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

CENSUS_URL = 'https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2026_Gazetteer/2026_Gaz_zcta_national.zip'
CENSUS_MEMBER = '2026_Gaz_zcta_national.txt'
GEONAMES_URL = 'https://download.geonames.org/export/zip/US.zip'
GEONAMES_MEMBER = 'US.txt'
CENSUS_SHA256 = 'f1e9046b91f6e60686a99343cb2752834c02b0764939403b331c78c017e2c54c'
GEONAMES_SHA256 = 'fe924ef45fda91f98f99578a2e9211133dbf5503d4bbfd7c8d5dfdd7cffdcdc3'
DOWNLOADED = '2026-10-23'
OUT = ROOT / 'migrations' / '146_zip_centroids.sql'
CACHE = ROOT / '.scratch' / 'zip-centroids'
BATCH = 1000

FIVE_DIGITS = re.compile(r'[0-9]{5}')
ROW_LINE = re.compile(r"^\('[0-9]{5}', -?[0-9]+\.[0-9]{4}, -?[0-9]+\.[0-9]{4}, '(census|geonames)'\),?$")
CENT = Decimal('0.0001')


def fail(message):
    print(message, file=sys.stderr)
    raise SystemExit(1)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def fetch(url, pinned, name, pin=True):
    """The archive's bytes: the cached file when its hash is the pin, otherwise a download, checked and then cached.

    Only bytes that match the pin are cached, so --print-hashes never replaces the pinned copy with a newer download.
    """
    path = CACHE / name
    if pin and path.is_file():
        data = path.read_bytes()
        if sha256(data) == pinned:
            return data
    request = urllib.request.Request(url, headers={'User-Agent': 'PrizeCheck zip centroid build'})
    with urllib.request.urlopen(request, timeout=120) as response:
        if response.status != 200:
            fail(f'{url}: answered {response.status}')
        data = response.read()
    actual = sha256(data)
    if pin and actual != pinned:
        fail(f'{url}: sha256 {actual} does not match the pinned {pinned}; the source changed, and a refresh is a new migration')
    if actual == pinned:
        CACHE.mkdir(parents=True, exist_ok=True)
        handle, temp = tempfile.mkstemp(dir=CACHE, prefix=f'.{name}.')
        with os.fdopen(handle, 'wb') as out:
            out.write(data)
        os.replace(temp, path)
    return data


def member(data, name):
    """One archive member, read in memory by its exact name."""
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            return archive.open(name).read().decode('utf-8')
    except (KeyError, zipfile.BadZipFile) as error:
        fail(f'archive member {name} could not be read: {error}')


def coordinate(text, low, high, what):
    try:
        value = Decimal(text.strip())
    except InvalidOperation:
        fail(f'{what}: {text!r} is not a number')
    if not value.is_finite() or not low <= value <= high:
        fail(f'{what}: {text!r} is out of range')
    return value


def census_rows(text):
    """{zip: (lat, lon)} from the Census ZCTA gazetteer: a header row, one delimited row per ZCTA."""
    first = text.split('\n', 1)[0]
    delimiter = '\t' if '\t' in first else '|'
    reader = csv.reader(io.StringIO(text), delimiter=delimiter)
    header = [column.strip() for column in next(reader, [])]
    for needed in ('GEOID', 'INTPTLAT', 'INTPTLONG'):
        if needed not in header:
            fail(f'the Census file has no {needed} column')
    geoid, lat, lon = (header.index(name) for name in ('GEOID', 'INTPTLAT', 'INTPTLONG'))
    rows = {}
    for fields in reader:
        if not fields or not any(field.strip() for field in fields):
            continue
        if len(fields) != len(header):
            fail(f'a Census row has {len(fields)} columns, expected {len(header)}')
        zip5 = fields[geoid].strip()
        if not FIVE_DIGITS.fullmatch(zip5):
            fail(f'Census GEOID {zip5!r} is not 5 digits')
        if zip5 in rows:
            fail(f'Census GEOID {zip5} appears twice')
        rows[zip5] = (coordinate(fields[lat], Decimal(-90), Decimal(90), f'Census {zip5} latitude'),
                      coordinate(fields[lon], Decimal(-180), Decimal(180), f'Census {zip5} longitude'))
    return rows


def geonames_rows(text):
    """({zip: (lat, lon)}, counts) from GeoNames US.txt: tab-separated, no header, 12 columns."""
    counts = {'read': 0, 'dropped_accuracy_1': 0, 'dropped_not_5_digits': 0, 'duplicates': 0}
    best = {}
    for line in text.split('\n'):
        if not line.strip():
            continue
        fields = line.rstrip('\r').split('\t')
        if len(fields) != 12:
            fail(f'a GeoNames row has {len(fields)} columns, expected 12')
        counts['read'] += 1
        accuracy_text = fields[11].strip()
        if accuracy_text and not re.fullmatch(r'[0-9]+', accuracy_text):
            fail(f'GeoNames accuracy {accuracy_text!r} is not an integer')
        accuracy = int(accuracy_text) if accuracy_text else 0
        if accuracy_text == '1':
            counts['dropped_accuracy_1'] += 1
            continue
        zip5 = fields[1].strip()
        if not FIVE_DIGITS.fullmatch(zip5):
            counts['dropped_not_5_digits'] += 1
            continue
        point = (coordinate(fields[9], Decimal(-90), Decimal(90), f'GeoNames {zip5} latitude'),
                 coordinate(fields[10], Decimal(-180), Decimal(180), f'GeoNames {zip5} longitude'))
        if zip5 in best:
            counts['duplicates'] += 1
            if accuracy <= best[zip5][0]:
                continue
        best[zip5] = (accuracy, point)
    return {zip5: point for zip5, (_, point) in best.items()}, counts


def merge(census, geonames):
    """[(zip, lat, lon, source)] sorted by zip, quantized to 4 decimals half-even; Census wins."""
    merged = {zip5: (point, 'census') for zip5, point in census.items()}
    for zip5, point in geonames.items():
        merged.setdefault(zip5, (point, 'geonames'))
    rows = []
    for zip5 in sorted(merged):
        (lat, lon), source = merged[zip5]
        rows.append((zip5, format(lat.quantize(CENT, ROUND_HALF_EVEN), 'f'),
                     format(lon.quantize(CENT, ROUND_HALF_EVEN), 'f'), source))
    return rows


def render(rows, census_hash, geonames_hash, counts, downloaded):
    census_n = sum(1 for row in rows if row[3] == 'census')
    geonames_n = len(rows) - census_n
    lines = [
        '-- Zip code centroids for open discovery (Trading #297, Stage 2 spec "Zip codes and distance";',
        '-- docs/planning/trading/migrations.md). Trading migrations use the reserved block 140-179.',
        '-- Re-runnable: the table is created if missing and every row is an upsert. Additive.',
        '--',
        '-- GENERATED by scripts/build_zip_centroids.py from the files below. Never edit by hand. This file may never',
        '-- change once it reaches dev (scripts/release.py); a refresh is a new migration that upserts zip_centroid and',
        '-- re-copies coordinates into discovery_setting.',
        f'-- Census: {CENSUS_URL} sha256 {census_hash}, {census_n} rows used',
        f'-- GeoNames: {GEONAMES_URL} (CC BY 4.0, geonames.org) sha256 {geonames_hash}, {counts["read"]} rows read,',
        f'--   {counts["dropped_accuracy_1"]} accuracy-1 dropped, {counts["dropped_not_5_digits"]} non-5-digit dropped,'
        f' {counts["duplicates"]} duplicates collapsed',
        f'-- Downloaded: {downloaded}',
        f'-- Rows: census {census_n}, geonames {geonames_n} (codes the Census file lacks), total {len(rows)}',
        '',
        "CREATE TABLE IF NOT EXISTS zip_centroid (zip char(5) PRIMARY KEY CHECK (zip ~ '^[0-9]{5}$'),",
        "  lat double precision NOT NULL, lon double precision NOT NULL,",
        "  source text NOT NULL CHECK (source IN ('census','geonames')));",
    ]
    for start in range(0, len(rows), BATCH):
        batch = rows[start:start + BATCH]
        lines.append('')
        lines.append('INSERT INTO zip_centroid (zip, lat, lon, source) VALUES')
        for index, (zip5, lat, lon, source) in enumerate(batch):
            line = f"('{zip5}', {lat}, {lon}, '{source}')" + (',' if index < len(batch) - 1 else '')
            if not ROW_LINE.match(line):
                fail(f'refusing to write an unexpected row: {line!r}')
            lines.append(line)
        lines.append('ON CONFLICT (zip) DO UPDATE SET lat = EXCLUDED.lat, lon = EXCLUDED.lon, source = EXCLUDED.source;')
    text = '\n'.join(lines) + '\n'
    text.encode('ascii')
    return text


def build(pin=True):
    census_data = fetch(CENSUS_URL, CENSUS_SHA256, 'census.zip', pin)
    geonames_data = fetch(GEONAMES_URL, GEONAMES_SHA256, 'geonames.zip', pin)
    census = census_rows(member(census_data, CENSUS_MEMBER))
    geonames, counts = geonames_rows(member(geonames_data, GEONAMES_MEMBER))
    rows = merge(census, geonames)
    if not 30000 <= len(rows) <= 50000:
        fail(f'{len(rows)} zip codes is outside the expected 30,000 to 50,000')
    return rows, sha256(census_data), sha256(geonames_data), counts, len(census)


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n', 1)[0])
    parser.add_argument('--print-hashes', action='store_true')
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--out', type=Path, default=OUT)
    args = parser.parse_args()
    rows, census_hash, geonames_hash, counts, census_read = build(pin=not args.print_hashes)
    if args.print_hashes:
        print(f'census sha256 {census_hash}, rows read {census_read}')
        print(f'geonames sha256 {geonames_hash}, {counts}')
        print(f'merged {len(rows)} rows; below 00500: {sum(1 for row in rows if row[0] < "00500")}')
        return 0
    text = render(rows, census_hash, geonames_hash, counts, DOWNLOADED)
    if args.check:
        if not args.out.is_file() or args.out.read_text(encoding='ascii') != text:
            print(f'{args.out.name} is stale', file=sys.stderr)
            return 1
        print(f'{args.out.name} is up to date ({len(rows)} rows)')
        return 0
    handle, temp = tempfile.mkstemp(dir=args.out.parent, prefix='.zip_centroids_', suffix='.tmp')
    try:
        with os.fdopen(handle, 'w', encoding='ascii', newline='\n') as file:
            file.write(text)
        os.chmod(temp, 0o644)
        os.replace(temp, args.out)
    except BaseException:
        if os.path.exists(temp):
            os.unlink(temp)
        raise
    print(f'wrote {args.out} ({len(rows)} rows, {len(text)} bytes)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
