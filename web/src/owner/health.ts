import type { OperationsStatus } from "../generated";

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
