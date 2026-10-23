# Research: free US zip-code centroid data

Researched 2026-10-22 for Trading Stage 2, which shows the distance between two collectors only as a band (under 5, 5–10, 10–25 or 25–50 mi) computed from their 5-digit zip codes.

## Recommendation

Use the **Census 2026 ZCTA Gazetteer** (`INTPTLAT`/`INTPTLONG`) as the primary source and **GeoNames `US.zip`** (CC BY 4.0) as a fallback for 5-digit codes the Census file lacks (PO-box-only and some unique ZIPs). Keep the GeoNames accuracy flag. When neither has a code, show no band rather than guess. Both can be bundled in the repository; GeoNames needs credit.

PostGIS is not needed. The distance is a haversine between two stored points, and a "within 50 mi" scan over about 33k rows works with a latitude/longitude bounding-box prefilter in plain SQL.

## Candidates

### Census ZCTA Gazetteer (2026)

- Index: https://www.census.gov/geographies/reference-files/time-series/geo/gazetteer-files.html
- File: https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2026_Gazetteer/2026_Gaz_zcta_national.zip (about 1 MB zipped)
- Fields: GEOID, GEOIDFQ, ALAND, AWATER, ALAND_SQMI, AWATER_SQMI, INTPTLAT, INTPTLONG ([record layouts](https://www.census.gov/programs-surveys/geography/technical-documentation/records-layout/gaz-record-layouts.html)).
- License: a U.S. Government work, so not copyrighted under [17 U.S.C. § 105](https://www.copyright.gov/title17/92chap1.html). The Census copyright page returned 404, so an explicit statement was not confirmed. The Census name must not imply endorsement ([API terms](https://www.census.gov/data/developers/about/terms-of-service.html), which govern the API rather than the files).
- Coverage: ZCTAs are generalized areas, not USPS ZIPs. Not every valid ZIP has a ZCTA; mixed, unique and PO-box-only ZIPs may be missing, and island areas are excluded ([ZCTA guidance](https://www.census.gov/programs-surveys/geography/guidance/geo-areas/zctas.html)). Row count is about 33k (unverified).

### GeoNames postal codes (`US.zip`)

- https://download.geonames.org/export/zip/ (619 KB; [readme](https://download.geonames.org/export/zip/readme.txt))
- License: CC BY 4.0. Credit with a link to www.geonames.org. Under AGENTS.md this is a legally required credit, so it belongs on a credits or about page, not in collector-facing trade screens.
- Fields include latitude, longitude and accuracy (1 estimated, 4 geonameid, 6 centroid of addresses or shape). Coordinates for unmatched codes are averages of neighbouring codes.

### HUD-USPS ZIP crosswalk

- https://www.huduser.gov/portal/datasets/usps_crosswalk.html
- Maps ZIPs to tracts, counties and CBSAs; it has no coordinates. API access needs a token. Not suitable alone.

### SimpleMaps free US zips

- Terms could not be read (403). Metro pages say the data license prohibits redistribution. Do not bundle it.

### zip-codes.com free database

- Personal use only, no redistribution. Not suitable.

## Privacy

- Polakis et al., CCS 2015, ["Where's Wally?"](https://www.cs.columbia.edu/~angelos/Papers/2015/ccsfp064-polakis.pdf): trilateration defenses in proximity services were bypassed, reportedly locating users to within metres.
- Xue et al., ["I Know Where You Are"](https://pure.ecnu.edu.cn/en/publications/i-know-where-you-are-thwarting-privacy-protection-in-location-bas/) (2015/2016): distance bands alone are defeated by repeated probes from varied positions.
- Mascetti et al., "A Practical Location Privacy Attack in Proximity Services": partial distance knowledge can locate many users to an area smaller than a city.

What this means for PrizeCheck: band edges are not a privacy control. What protects collectors is that only opted-in collectors can query, that the probe position is a zip centroid rather than a free coordinate, and that zip changes are limited (three a day, owner-approved). Because the target is itself a zip centroid, the most an attacker can learn is the target's zip, never an address. Large rural ZCTAs put the centroid far from the collector, which widens band error; assign boundary cases conservatively.

These findings come from abstracts and summaries only.

## Unresolved

- Explicit Census license wording and exact row count.
- GeoNames US row count and PO-box coverage.
- Typical zip-centroid error in miles for these bands.
