# TCGCSV prices launch checklist

**Ticket:** [#355](https://github.com/ry-cen/prizecheck/issues/355), under the TCGCSV prices plan ([tickets.md](tickets.md), P8).
**Design:** [design.md](design.md), section 4.11. **Decision:** [ADR 0019](../../adr/0019-tcgcsv-daily-prices.md).
**Drafted:** 2026-10-28.

The cutover was designed as two releases so that readers switch only after the price data is complete; both shipped together in v0.2.1. Run each step on the Oracle host, in a shell on the instance, with the deploy script path set once:

```sh
P=/opt/prizecheck-prod/bin/prizecheck-deploy.sh
```

The job's exit codes (`scripts/price_import_job.py`): 0 imported, unchanged, or another run holds the lock; 1 the database is unreachable; 2 failed; 3 partial.

## Where production stands (2026-10-28)

- Release B is live: the readers already read the TCGCSV tables.
- The first import ran on 2026-10-28, 06:01 to 06:05 UTC, and exited 0. It reported 25,093 verified Editions, of which 24,509 are priced. Unpriced by reason: `uncovered_variant` 528, `no_product_rows` 33, `no_price` 14, `shared_price` 9.
- That run logged `publishing the public price records failed (PublishRaced)`. The import records this in `price_import.public_error` and goes on; the public `price:` records need another publish (see "Clear the publish failure" below).
- Marketplace matching is still v3. Matching v4 is **not** activated, so the promo sets (svp, mep, swshp and the Black Star sets) are not yet verified or priced.

## Release A. The data

Release A carries the importer, the binding and the writer of the public `price:` records. Readers stay on the legacy path, the migrations (152 to 154) are additive, and nothing collector-facing changes.

- [x] Deploy release A.
- [x] Run the first import by hand (it takes about 2 to 4 minutes):

   ```sh
   sudo bash $P tool /app/scripts/price_import_job.py
   ```

   Done on 2026-10-28, exit 0 (see above).

- [ ] At a quiet time, activate matching rule v4 on the host. Use the command in [deployment-oracle.md](../../deployment-oracle.md), step 14.3, with `('marketplace_matching', 4)` only, or Owner controls' **Rules** panel once [#343](https://github.com/ry-cen/prizecheck/issues/343) has shipped. The activation of v3 took 18 minutes on the 1-OCPU production instance.
- [ ] Import again with `--force`. It rebinds and publishes. Add `--rematch` to also re-evaluate the unverified promo Editions under v4:

   ```sh
   sudo bash $P tool /app/scripts/price_import_job.py --force
   ```

   Exit 0 is expected. A 3 (partial) or 2 (failed) needs a look at the job's log before going on.

- [ ] Clear the publish failure. If the run still logs `publishing the public price records failed`, rebind and publish without downloading:

   ```sh
   sudo bash $P tool /app/scripts/price_import_job.py --rebind-only
   ```

- [ ] Spot checks (design acceptance criteria 4 and 5). Open the owner panel (Owner controls, the price import line), or query the tables:

   ```sh
   sudo bash $P compose exec db psql -U prizecheck -d prizecheck -c \
     "select id, finished_at, outcome, verified_editions, priced_editions, unpriced, public_error from price_import order by id desc limit 3;"
   sudo bash $P compose exec db psql -U prizecheck -d prizecheck -c \
     "select product_id, sub_type_name, reason, count(*) from edition_price_binding where product_id in (106999, 42382, 500070, 654594, 656800) group by 1, 2, 3 order by 1;"
   ```

   - [ ] Priced and verified counts are plausible next to the 2026-10-28 figures, and `public_error` is empty on the newest row.
   - [ ] svp, mep and swshp are bound: Koraidon ex (product 500070) and Meganium (product 654594) have a `sub_type_name`. Staff (product 656800) is bound only if no sibling Edition shares that product; `reason` `shared_price` is correct otherwise.
   - [ ] base1-4's three Editions (acceptance criterion 4): Shadowless is product 106999 with `Unlimited Holofoil`, 1st Edition Shadowless is product 106999 with `1st Edition Holofoil`, and unlimited is product 42382 with `Holofoil`.
   - [ ] `price:` public records exist for the Editions of an existing Published Deck: open that deck's public link and check that its cost answers.

## Release B. The readers

Release B carries the reader switch. The tables and records are already populated, so there is no gap.

- [x] Deploy release B. Live on production (see above).
- [ ] Check one card's price, one Deck cost and one Published Deck cost.
- [ ] Look at the owner panel the next day: the daily import ran (`catalog-refresh`, below) and the newest row is within 48 hours.

## The daily run

`prizecheck-deploy.sh catalog-refresh` runs the price import first, then the catalog check, then the scanner index, and carries on to the later steps whatever the import returned. It ends non-zero when the import exited with anything but 0. The command depends on what the host runs. Until a release carrying #339 and #355 is deployed and the host files are reinstalled, the daily command is the price import alone:

```sh
sudo bash $P tool /app/scripts/price_import_job.py
```

After that, run `catalog-refresh` by hand daily, or at least before each release:

```sh
sudo bash $P catalog-refresh
```

Once the timer from [#341](https://github.com/ry-cen/prizecheck/issues/341) is installed, it runs `catalog-refresh` for you.

- [ ] The timer runs it every day (#341 owns the timer and its checklist).

## Fix forward

**Release A is never redeployed to bring back TCGdex prices.** No step here does that. A wrong or broken release B is handled in this order:

1. **Hide prices that are wrong.** Set `PRICE_READS=off` in the env file (`prizecheck.env` in `/opt/prizecheck-prod/`) and restart the API:

   ```sh
   sudo bash $P compose up -d api
   ```

   Every private and public price row then answers unavailable without querying anything, and Deck, Want List and Trade costs read as having no quotes. No image change is needed and TCGdex is never read.

2. **Repair data that stays on TCGCSV.** Rows are never deleted. Fix the cause, then run the job again with `--force`, or run `--rebind-only` when the downloaded rows are right and only the binding or the publish was wrong:

   ```sh
   sudo bash $P tool /app/scripts/price_import_job.py --force
   sudo bash $P tool /app/scripts/price_import_job.py --rebind-only
   ```

   If the price tables themselves are damaged, restore them from the newest dump in `/opt/prizecheck-prod/backups/` first (the nightly 03:17 UTC backup from `/etc/cron.d/prizecheck-backup`, or a pre-deploy dump; see [deployment-oracle.md](../../deployment-oracle.md)), then run `--rebind-only`.

3. **Ship a follow-up release** from `dev` with the fix, keeping the TCGCSV readers, then set `PRICE_READS=on` again and restart the API as in step 1.

A reader failure (an exception or a timeout) already answers "unavailable" for that row, so step 1 is only for wrong prices.

## Sign-off

| Step | Done on | By | Result |
| --- | --- | --- | --- |
| Release A deployed | shipped with release B in v0.2.1 | | |
| First import by hand | 2026-10-28 | | exit 0, 24,509 of 25,093 priced |
| Matching v4 activated | | | |
| `--force` re-import | | | |
| Spot checks | | | |
| Release B deployed |  | | |
| Release B checks | | | |
