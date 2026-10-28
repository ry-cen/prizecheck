# Catalog auto-refresh launch checklist

**Ticket:** [#341](https://github.com/ry-cen/prizecheck/issues/341).
**Decision:** [ADR 0018](../../adr/0018-scheduled-catalog-change-check.md). **Plan:** [tickets.md](tickets.md).
**Drafted:** 2026-10-27, on `feature/catalog-refresh-timer`.

The units and the guide steps are checked in CI. These checks need the production host, so a person runs them once and fills in the blanks. `systemd-analyze verify` is not available on a Mac, so run it on the host too.

## Before any check

1. **Deploy the release** that contains the `catalog-refresh` subcommand and the price import step ([#355](https://github.com/ry-cen/prizecheck/issues/355)), and reinstall `prizecheck-deploy.sh` on the host from that commit, so the first scheduled run includes prices (step 16 of the Oracle guide depends on #355 being deployed).
2. **Copy the units to the host** as step 16 of the [Oracle guide](../../deployment-oracle.md) says.

## Checks

- [ ] Install the units on prod: `sudo install -m 0644` the two files to `/etc/systemd/system/`, `daemon-reload`, `enable --now` the timer.
- [ ] `systemd-analyze verify /etc/systemd/system/prizecheck-catalog-refresh.service /etc/systemd/system/prizecheck-catalog-refresh.timer` prints no warning about these two units (Oracle's own `unified-monitoring-agent` units may be named).
- [ ] `systemctl list-timers prizecheck-catalog-refresh.timer` shows a next run near 04:00 UTC.
- [ ] First run by hand: `sudo systemctl start --no-block prizecheck-catalog-refresh`; `journalctl -u prizecheck-catalog-refresh` shows the price import, the check and the scanner index and ends with "Catalog refresh finished" (or the errors it names), and `systemctl status` shows the exit status.
- [ ] Owner controls shows the last automatic check (needs [#340](https://github.com/ry-cen/prizecheck/issues/340) deployed; skip it until then).
- [ ] Optional: the User Scripts entry on the dev host, and its first log.
- [ ] No interim price-import cron exists on prod (`ls /etc/cron.d`; none existed on 2026-10-28), so the timer is the only scheduler of the price import.

| Step | Done on | By | Result |
| --- | --- | --- | --- |
| Units installed | | | |
| `systemd-analyze verify` | 2026-10-28, before install (copies in `/tmp`) | | Exit 0; the only warnings named Oracle's own `unified-monitoring-agent` units. Repeat on the installed paths. |
| `list-timers` (next run) | | | |
| First run (exit status, journal tail) | | | |
| Dev User Scripts entry (optional) | | | |
| No interim price-import cron | | | |
