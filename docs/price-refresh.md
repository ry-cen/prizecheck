# Price refresh (retired)

The access-triggered price refresh (admission, the price runners and their record contract, tickets 07 and 08) and
catalog-import price seeding are retired. Prices now come from one daily TCGCSV import stored in PostgreSQL
([ADR 0019](adr/0019-tcgcsv-daily-prices.md)); see [docs/prices.md](prices.md) for the import, binding, reads, public
`price:` records and failure handling.

Records the retired refresh left in a public record store (`quote`, `result`, `fence`, `work`, `admission`, `lease` and
`backoff` keys) are inert and are deleted by `scripts/purge_price_records.py` (a dry run by default; `--delete` deletes).
The earlier contract is in this file's git history.
