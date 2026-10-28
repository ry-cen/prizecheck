# Catalog auto-refresh: tickets

Decision: [ADR 0018](../../adr/0018-scheduled-catalog-change-check.md). Issues: [#339](https://github.com/ry-cen/prizecheck/issues/339), [#340](https://github.com/ry-cen/prizecheck/issues/340), [#341](https://github.com/ry-cen/prizecheck/issues/341), labelled `implementation` and `feature: catalog auto-refresh`. Terms are those of [CONTEXT.md](../../../CONTEXT.md). Related, not in scope: [#338](https://github.com/ry-cen/prizecheck/issues/338).

Each ticket is accepted on its own narrow tests plus `npm run check` and `npm run guardrails`; the pull request is accepted on green GitHub CI, and the full local gate is optional ([verification](../../agents/verification.md)). Collector-facing screens must show nothing about the check ([AGENTS.md](../../../AGENTS.md), UI copy).

## 1. (#339) Daily change check, its record, and the `catalog-refresh` subcommand

**What to build.** A check that reads the TCGdex card list, applies the importer's exclusions, compares source ids with the active generation's live Printings (not tombstoned, `source = 'tcgdex'`), and records the outcome. If ids differ it starts a pull through `dispatch_import`, waits for that run to finish, and exits with a code the host script reads. A `catalog-refresh` subcommand in `prizecheck-deploy.sh` runs the check in the API image, then runs `compose run --rm scanner-index` on every refresh, whatever the check found, except after a pull that failed. It then records the index's exit code on the check row (a second call, `python -m app.catalog_refresh --record-index <check id> <exit code>`, since the host cannot write the row itself).

- Reuse `TCGdexSource.enumerate()` and its exclusion requests (`/series/tcgp`, `/sets/<id>`) rather than copying them; the check does not fetch `/v2/en/sets`.
- The importer sets no User-Agent today (`httpx.Client(...)` in `TCGdexSource.__init__`). Add one there, so the importer and the check identify the same way: `PrizeCheck-catalog/1 (+<contact>)`, contact from `SCANNER_INDEX_CONTACT` else `OWNER_EMAIL`, as `scripts/scanner_index_job.py` does. The check's retries are bounded well below the importer's 12 attempts.
- `dispatch_import` returns one run id for a new run and for an already-active one, and `None` while a promotion commits. The check must tell "started" from "was running" (outcome `pull_started` against `pull_running`) and treat `None` as `pull_running`.
- Migration `151_catalog_check.sql`: `catalog_check(id, started_at, finished_at, outcome, new_count, removed_count, catalog_run_id, error_code, index_exit_code)` with a CHECK on `outcome` (`no_change`, `pull_started`, `pull_running`, `paused`, `failed`). A row is inserted at start with a null outcome and finished when the check ends, so a crash leaves an unfinished row.
- The subcommand does not hold `deploy.lock` while it waits for the pull (that would make a deploy fail after 120 s); it takes its own non-blocking lock `state/catalog-refresh.lock`, so two timer runs never overlap. It uses the current release's image like `cmd_tool`. The pull runs as a child of the container that called `dispatch_import`, so the container stays up until the run ends; the check waits on the `catalog_run` row.

**Acceptance criteria.**

- [ ] With TCGdex and the catalog agreeing, the check records `no_change` with zero counts, starts no `catalog_run`, and exits 0.
- [ ] With ids TCGdex lists that the catalog lacks, it records `pull_started`, the new count and the run id, and a pull begins; with catalog ids TCGdex no longer lists, the removed count is recorded the same way.
- [ ] Excluded-series ids and tombstoned or `manual` Printings never count as a difference.
- [ ] With a pull already running (owner-started or earlier) it records `pull_running` and starts nothing; the host script still runs the scanner index, which exits 3 if the pull's own index run holds the lock.
- [ ] A TCGdex failure after bounded retries records `failed` with an error code and no `catalog_run`; an invalid list (empty, duplicate ids) fails, never reads as "everything removed".
- [ ] A pull the check started that fails (including the greater-than-1% drop guard) skips the scanner index and exits non-zero; the next day's check starts a pull again because the difference remains.
- [ ] After 3 consecutive check-started pulls fail (consecutive among the check's own pulls; an owner-started failure does not count), the next check records `paused` with the last error code, starts no pull, and still lets the index run. A successful pull, owner-started or check-started, clears the pause: the next check compares ids again. A test drives three failures, the pause, and the clearing by each kind of successful pull.
- [ ] A changed existing card still becomes a `catalog_review` item; the check does not bypass review.
- [ ] `catalog-refresh` runs `scanner-index` after every check (after the pull when one ran and succeeded), records its exit code on the check row, and exits non-zero and logs when that code is 1 to 3. With nothing due the index exits 0.
- [ ] Requests carry the User-Agent; no secret or raw payload reaches logs.
- [ ] `catalog-refresh` runs by hand with the same result as from the timer, and appears in `usage` and `prizecheck-deploy.sh` tests.

**Blocked by.** Nothing.

**Likely touched.** New `api/app/catalog_refresh.py` (run as `python -m app.catalog_refresh`); `api/app/catalog_dispatch.py` (distinguish started from active); `api/app/catalog.py` (User-Agent on the importer's client; reuse of `enumerate`); `migrations/151_catalog_check.sql`; `deploy/host/prizecheck-deploy.sh`.

**Verification.** `npm run verify -- --suite api -- api/tests/test_catalog_refresh.py api/tests/test_catalog_dispatch.py api/tests/test_catalog_excluded_series.py api/tests/test_catalog_process.py` (the new file uses the fake sources of `test_catalog.py`); `npm run guardrails` runs `tests/tooling/test_deploy_pipeline.py`, extended for the subcommand with a stubbed `docker` (the index runs after every check except after a failed pull, and its exit code is recorded).

## 2. (#340) Owner controls shows the last automatic check and what the last pull changed

**What to build.** `GET /api/admin/catalog-runs` gains `last_check`: outcome, started and finished times, new and removed counts, the run it started and that run's outcome, error code, and the scanner index's exit code, or null before any check. The Owner controls status panel shows it beside the existing pull status, for example "Last automatic check: today 04:07, 182 new printings, pull succeeded", "No change", "Check failed", or "Automatic pulls are paused after 3 failed pulls: <error code>", plus a line when the card index failed. Owner screens may show times and error codes. Nothing is added to `GET /api/catalog/status` or any collector screen.

**Acceptance criteria.**

- [ ] The owner endpoint returns `last_check` for the newest `catalog_check` row; before any row it is null and the panel says no automatic check has run.
- [ ] After a `pull_started` check, the panel shows the new and removed counts and whether the run is running, succeeded or failed.
- [ ] `no_change`, `pull_running`, `paused` and `failed` each have their own panel text; a `failed` check shows its error code.
- [ ] A `paused` check shows that automatic pulls are paused and why (the last error code); once a later pull succeeds the panel no longer says paused. A test covers both.
- [ ] A non-zero `index_exit_code` shows as a failed scanner index with its code; zero or null shows nothing extra.
- [ ] A non-owner gets 403 as before; `GET /api/catalog/status` is unchanged and no collector page or response mentions the check.
- [ ] The generated API client (`web/src/generated.ts`) is regenerated, not hand-edited.
- [ ] The panel stays readable on a phone width and keeps its 5-second refresh while a run is active.

**Blocked by.** Ticket 1 (the table).

**Likely touched.** `api/app/catalog_status.py`; `web/src/owner/StatusPanel.tsx`, `web/src/owner/OwnerControlsPage.tsx`, `web/src/owner/health.ts`; `web/src/generated.ts`.

**Verification.** `npm run verify -- --suite api -- api/tests/test_catalog.py -k catalog_runs` (the owner endpoint's tests live there); `npm run verify -- --suite browser -- web/tests/owner-controls.spec.ts`, with one test per outcome and one that a collector's catalog page carries no check text.

## 3. (#341) Host timer, install steps and operations entry

**What to build.** `deploy/host/prizecheck-catalog-refresh.service` (oneshot, runs `prizecheck-deploy.sh catalog-refresh`, logs to the journal) and `prizecheck-catalog-refresh.timer` (`OnCalendar=*-*-* 04:00:00 UTC`, `RandomizedDelaySec`, `Persistent=true`). The Oracle guide gets a step to install and enable them, and a line in "Updating the host files" that the units are not in the CI digest. The Unraid guide documents the same command as an optional User Scripts entry. `docs/operations/portable-jobs.md` gets a row for the job and its exit codes, and its scanner index paragraph stops saying no scheduler runs the job on production.

**Acceptance criteria.**

- [ ] The units pass `systemd-analyze verify`; the timer fires once a day, not on every boot, and a missed run runs once at the next start.
- [ ] Oracle guide step: `install` the two units to `/etc/systemd/system/`, `daemon-reload`, `enable --now` the timer, `systemctl list-timers` shows it, and a first run by hand with `systemctl start` is shown with where its output lands (`journalctl -u prizecheck-catalog-refresh`).
- [ ] The step says the timer must be reinstalled on a new host (including an AWS move) and that a changed unit needs `daemon-reload`.
- [ ] The Unraid guide marks the schedule optional and gives the User Scripts command; the Oracle guide's catalog step now says the first pull is still started by hand.
- [ ] `portable-jobs.md` lists the job, its UTC schedule, its command and exit codes, and links ADR 0018.
- [ ] ADR 0017's "no scheduler" sentence is read against ADR 0018; if it now misleads, a one-line amendment points to ADR 0018.
- [ ] Every file path and command in the new text exists in the repository.

**Blocked by.** Ticket 1 (the subcommand).

**Likely touched.** `deploy/host/` (two new unit files); `docs/deployment-oracle.md` (new step after 14, "Updating the host files"); `docs/deployment-unraid.md`; `docs/operations/portable-jobs.md`; `tests/tooling/test_deploy_pipeline.py`.

**Verification.** `npm run guardrails` (runs `tests/tooling/test_deploy_pipeline.py`, extended so the units exist, name the subcommand and carry the schedule). On the Oracle host, the first run and `list-timers` output go in a launch checklist for this feature, because the repository cannot prove a timer is installed.
