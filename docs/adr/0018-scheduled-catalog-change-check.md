# Check TCGdex for new cards every day and pull only when something changed

**Status:** accepted on 2026-10-27; planning decision, not yet implemented. Supersedes the "no scheduled catalog sync" part of [ADR 0003](0003-on-demand-catalog-imports.md) and of the [catalog architecture resolution](../planning/tcg-collection-tracker/wayfinder/resolutions/05-decide-catalog-architecture.md). The owner decided on 2026-10-27 that new TCGdex cards are pulled in automatically. Everything else in both documents still applies: the pull, its validation, the review queue and the atomic promotion are unchanged. The plan is in [catalog auto-refresh tickets](../planning/catalog-auto-refresh/tickets.md).

Every catalog pull is started by the owner from Owner controls and re-enumerates all of TCGdex: about 21,000 one-card requests, about 15 minutes on the 1-OCPU production host. New sets reach collectors only when the owner remembers to start one. The source has no change feed ([earlier source investigation](../planning/tcg-collection-tracker/wayfinder/research/tcgdex-card-identity.md)), so a daily full pull would cost 21,000 requests a day to learn, most days, that nothing changed.

**Decision.**

- **A daily change check, not a daily full pull.** The check reads the brief card list (`GET https://api.tcgdex.net/v2/en/cards`), applies the exclusions the importer applies by calling the importer's own enumeration (the TCG Pocket series: `/series/tcgp` and its sets, `EXCLUDED_SERIES` in `api/app/catalog.py`), and compares the source ids with the live Printings of the active catalog generation. If TCGdex lists ids the catalog lacks, or the catalog holds ids TCGdex no longer lists, it starts a pull. Otherwise it records "no change" and exits.
- **The pull goes through the existing dispatch.** The check calls `dispatch_import` (`api/app/catalog_dispatch.py`), so its advisory locks decide: a running pull, owner-started or earlier, is left alone and nothing runs twice. The pull is the ordinary pull. The check does not skip the greater-than-1% source-drop guard or the review queue; a changed existing card still becomes a `catalog_review` item for the owner.
- **The scanner index runs on every refresh.** After the check, and after the pull when one ran and succeeded, the job runs the scanner index incrementally (`compose run --rm scanner-index`, [ADR 0017](0017-on-device-recognition-assets-and-the-scanner-index-job.md): only Printings without a fingerprint), whatever the check found; it exits 0 when nothing is due. The index exit code is recorded on the check row. When a pull fails, the job skips the index. The next day's check finds the same difference and starts again; a deploy that interrupts a pull is handled the same way.
- **Repeated failures pause automatic pulls.** After 3 consecutive check-started pulls fail, the check stops starting pulls and records outcome `paused` with the last error code. Any successful pull, owner-started or check-started, clears the pause. Owner controls shows that automatic pulls are paused and why.
- **A host timer runs it, as the nightly backup is run from the host.** A systemd timer on the Oracle host fires daily at 04:00 UTC with `RandomizedDelaySec` and calls `/opt/prizecheck-prod/bin/prizecheck-deploy.sh catalog-refresh`. That new subcommand runs the check in the API image, waits for the pull it started, then runs the scanner index. The unit files ship in `deploy/host/` and the Oracle guide gets a step to install them. On the Unraid dev host the timer is optional (a User Scripts entry, documented). An operator can run the same subcommand by hand.
- **Each check is recorded in PostgreSQL.** One row per check: started and finished times, outcome (`no_change`, `pull_started`, `pull_running`, `paused`, `failed`), counts of new and removed ids, the `catalog_run` it started, an error code, and the scanner index's exit code. Owner controls' status panel shows the last automatic check and, after a pull the check started, what changed (for example "182 new printings"). Owner screens may show check times ([AGENTS.md](../../AGENTS.md) exempts them). Collector-facing screens show nothing about the check.
- **The check is polite.** It identifies itself with a User-Agent, makes one attempt plus a bounded number of retries per request, and the timer fires at most once a day.
- **No new mail or notification channel.** Production sends no mail. A failure shows in the Owner controls panel and in the host journal.

**Considered options.**

- **A daily full pull.** Rejected: about 21,000 requests and 15 minutes of a 1-OCPU host every day to confirm no change.
- **A timer inside the API container.** Rejected: [ADR 0003](0003-on-demand-catalog-imports.md) keeps the API free of resident job loops, and the backup already runs from the host.
- **Mail the owner on a failure.** Rejected: production sends no mail.

**Consequences.**

- **TCGdex load.** About a handful of small requests a day (the card list, plus the excluded series and its sets), and a full pull only on a day something changed.
- **Review items can appear unprompted.** A pull the owner did not start can leave `catalog_review` items and move the catalog revision. Collectors see new Printings with no note, and search shows a later last-pull time.
- **A pull that cannot succeed stops after three tries.** If the difference never clears (a greater-than-1% drop the owner has not resolved, or a listed id the importer rejects), three daily pulls fail and the check then pauses until a pull succeeds, so a stuck catalog costs three pulls, not one a day.
- **A failed index is retried daily.** The index runs on every refresh, so a failure (exit code 2 or 3) is retried the next day and shown on the owner panel.
- **A timer per environment.** The units live in `deploy/host/` but the digest CI sends covers only the compose files and the deploy script, so a host reinstalls them by hand. A move to AWS must install the timer on the new host.
- **Related, not part of this work.** [#338](https://github.com/ry-cen/prizecheck/issues/338): a healthy promotion is reported stale on a slow host.
