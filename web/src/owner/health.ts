import type { OperationsStatus, OwnerCatalogStatus } from "../generated";

/** bad: wrong now (a stale backup); warn: needs attention soon (a 70% allowance warning); unverified: no
 * recent measurement; ok: fine. A check isn't OK only when the server flags it or can't measure it. Counts
 * that only grow (failed jobs, failed pulls) and pending work are shown, but never raise a tone. */
export type HealthTone = "bad" | "warn" | "unverified" | "ok";

export type HealthCheck = {
  area: string;
  check: string;
  /** The Pill's text; it says the status on its own. */
  value: string;
  tone: HealthTone;
  detail: string;
};

const RANK: Record<HealthTone, number> = {
  bad: 0,
  warn: 1,
  unverified: 2,
  ok: 3,
};

const when = (value: string | null) =>
  value ? new Date(value).toLocaleString() : null;

/** Every operational health check, in the table's order. */
export function healthChecks(status: OperationsStatus): HealthCheck[] {
  const stale = status.backup_state === "stale" || status.backup_stale;
  const checks: HealthCheck[] = [
    {
      area: "Backups",
      check: "Backup",
      value: stale
        ? "Stale"
        : status.backup_state === "fresh"
          ? "Fresh"
          : "Unverified",
      tone: stale
        ? "bad"
        : status.backup_state === "fresh"
          ? "ok"
          : "unverified",
      detail: `Last success: ${when(status.backup_last_success) ?? "never"} · Failed jobs: ${status.backup_failures}`,
    },
    {
      area: "Backups",
      check: "Disposable restore",
      value: when(status.restore_last_success) ?? "Unverified",
      tone: status.restore_last_success ? "ok" : "unverified",
      detail: `Failed restores: ${status.restore_failures}`,
    },
    {
      area: "Backups",
      check: "Backup watchdog",
      value: when(status.watchdog_last_check) ?? "Unverified",
      tone: status.watchdog_last_check ? "ok" : "unverified",
      detail: `Stale backup alerts: ${status.backup_alerts}`,
    },
    {
      area: "Sign-in, 24 hours",
      check: "Sign-in requests",
      value: String(status.sign_in_requests_24h),
      tone: "ok",
      detail: "",
    },
    {
      area: "Sign-in, 24 hours",
      check: "Sign-in delivery",
      value:
        status.sign_in_delivery === "recorded"
          ? `${status.sign_in_delivered ?? 0} delivered`
          : "Unverified",
      tone: status.sign_in_delivery === "recorded" ? "ok" : "unverified",
      detail:
        status.sign_in_delivery === "recorded"
          ? `Delivery failures: ${status.sign_in_failed ?? 0}`
          : "No delivery has been recorded",
    },
    {
      // New accounts against DAILY_SIGNUP_CAP (#155); the server warns at 80%.
      area: "Sign-in, 24 hours",
      check: "New accounts",
      value: `${status.signups_24h} / ${status.daily_signup_cap}${status.signup_warning ? " · 80% warning" : ""}`,
      tone: status.signup_warning ? "warn" : "ok",
      detail: `Refused for too many sign-ins: ${status.signup_refusals}`,
    },
    {
      area: "Private API, 24 hours",
      check: "Requests",
      value: String(status.api_requests_24h),
      tone: "ok",
      detail: `Failures: ${status.api_failures_24h} · Authorization denials: ${status.authorization_denials_24h}`,
    },
    {
      area: "Private API, 24 hours",
      check: "Mean response",
      value:
        status.api_mean_ms_24h === null
          ? "Unverified"
          : `${Math.round(status.api_mean_ms_24h)} ms`,
      tone: status.api_mean_ms_24h === null ? "unverified" : "ok",
      detail: "",
    },
    {
      area: "Catalog",
      check: "Failed catalog pulls",
      value: String(status.catalog_failures),
      tone: "ok",
      detail: "Since the first pull",
    },
    {
      area: "Catalog",
      check: "Pending catalog reviews",
      value: String(status.catalog_pending_reviews),
      tone: "ok",
      detail: "",
    },
    {
      area: "Public delivery",
      check: "Catalog deliveries pending",
      value: String(status.catalog_outbox_pending),
      tone: "ok",
      detail: `Oldest pending: ${
        status.catalog_outbox_oldest_seconds === null
          ? "none"
          : `${Math.round(status.catalog_outbox_oldest_seconds)} s`
      }`,
    },
    {
      area: "Public delivery",
      check: "Projections pending",
      value: String(status.projection_pending),
      tone: "ok",
      detail: `Projection failures: ${status.projection_failures} · Release failures: ${status.release_failures}`,
    },
  ];
  if (!status.quotas.length)
    checks.push({
      area: "Provider allowances",
      check: "Provider allowances",
      value: "Unverified",
      tone: "unverified",
      detail: "No measurement recorded",
    });
  for (const quota of status.quotas)
    checks.push({
      area: "Provider allowances",
      check: quota.resource,
      value: !quota.verified
        ? "Unverified"
        : `${quota.used} / ${quota.allowance}${quota.warning ? " · 70% warning" : ""}`,
      tone: !quota.verified ? "unverified" : quota.warning ? "warn" : "ok",
      detail: quota.verified
        ? `Measured ${when(quota.measured_at)}`
        : "Measurement is stale",
    });
  return checks;
}

/** The checks that aren't OK, worst first; checks of one tone keep the table's order. */
export function problems(checks: HealthCheck[]): HealthCheck[] {
  return checks
    .filter((check) => check.tone !== "ok")
    .sort((a, b) => RANK[a.tone] - RANK[b.tone]);
}

/** The owner panel's price import lines (design 4.12): what the last import did, then one red line per problem.
 * Owner screens may name TCGCSV and TCGplayer and show times; collector screens never do. */
export function priceImportLines(status: OwnerCatalogStatus): {
  info: string[];
  warnings: string[];
} {
  const last = status.last_price_import;
  if (!last)
    return { info: ["Prices have not been imported yet."], warnings: [] };
  const info: string[] = [];
  const warnings: string[] = [];
  const good = when(status.last_good_price_import_at ?? null);
  const source = when(last.source_updated_at ?? null);
  info.push(
    `Prices: imported ${good ?? "never"} (TCGplayer data from ${source ?? "unknown"})` +
      (last.verified_editions == null || last.priced_editions == null
        ? ""
        : `, ${last.priced_editions.toLocaleString()} of ${last.verified_editions.toLocaleString()} verified Editions priced`)
  );
  const unpriced = Object.entries(last.unpriced ?? {}) as [string, number][];
  if (unpriced.length)
    info.push(
      `Unpriced: ${unpriced.map(([reason, n]) => `${reason.replaceAll("_", " ")} ${n.toLocaleString()}`).join(" · ")}`
    );
  if (last.fallback_art !== null && last.fallback_art !== undefined)
    info.push(
      `${last.fallback_art.toLocaleString()} Printings use TCGplayer art`
    );
  if (last.outcome === "failed" || last.outcome === "partial")
    warnings.push(
      `The latest price import ${last.outcome === "failed" ? "failed" : "was partial"}` +
        (last.error_code ? ` (${last.error_code})` : "") +
        ` · Groups failed: ${last.groups_failed}`
    );
  if (last.public_error)
    warnings.push(`Publishing prices failed: ${last.public_error}`);
  if (status.price_import_stale)
    warnings.push(
      `The last good price import is over 48 hours old (${good ?? "never"}).`
    );
  if (status.price_source_stale)
    warnings.push(
      `TCGCSV's own update time is over 48 hours old (${when(status.source_updated_at_max ?? null) ?? "never"}).`
    );
  return { info, warnings };
}

/** The owner panel's automatic-check lines (#340): what the last scheduled check did, then red lines for a failed
 * check, a pause or a failed card index. Owner screens may show times and error codes; collector screens show nothing. */
export function catalogCheckLines(status: OwnerCatalogStatus): {
  info: string[];
  warnings: string[];
} {
  const check = status.last_check;
  if (!check) return { info: ["No automatic check has run."], warnings: [] };
  const info: string[] = [];
  const warnings: string[] = [];
  const at = when(check.started_at);
  const printings = (n: number) =>
    `${n.toLocaleString()} new printing${n === 1 ? "" : "s"}`;
  if (!check.outcome) {
    if (check.unfinished_stale)
      warnings.push(`The automatic check started ${at} did not finish.`);
    else info.push(`Automatic check running (started ${at}).`);
  } else if (check.outcome === "no_change") {
    info.push(`Last automatic check: ${at}, no change.`);
  } else if (check.outcome === "pull_started") {
    const counts = `${printings(check.new_count ?? 0)}, ${(check.removed_count ?? 0).toLocaleString()} removed`;
    const pull = check.run_outcome
      ? check.run_outcome === "succeeded"
        ? "pull succeeded"
        : `pull failed${check.error_code ? ` (${check.error_code})` : ""}`
      : "pull running";
    const line = `Last automatic check: ${at}, ${counts}, ${pull}`;
    if (check.run_outcome && check.run_outcome !== "succeeded")
      warnings.push(line);
    else info.push(line);
  } else if (check.outcome === "pull_running") {
    info.push(
      `Last automatic check: ${at}, a pull was already running, so none was started.`
    );
  } else if (check.outcome === "paused") {
    if (check.pull_succeeded_after)
      info.push(
        `Last automatic check: ${at}, no pull started. A later pull succeeded.`
      );
    else
      warnings.push(
        `Automatic pulls are paused after 3 failed pulls: ${check.error_code ?? "unknown"}`
      );
  } else {
    warnings.push(
      `Check failed: ${at}${check.error_code ? ` (${check.error_code})` : ""}`
    );
  }
  if (check.index_exit_code)
    warnings.push(`Card index failed (exit code ${check.index_exit_code}).`);
  return { info, warnings };
}
