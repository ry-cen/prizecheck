CREATE TABLE operations_state (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 backup_last_success timestamptz,
 restore_last_success timestamptz,
 backup_failures bigint NOT NULL DEFAULT 0,
 restore_failures bigint NOT NULL DEFAULT 0,
 backup_stale boolean NOT NULL DEFAULT false,
 backup_alerts bigint NOT NULL DEFAULT 0,
 watchdog_last_check timestamptz,
 projection_failures bigint NOT NULL DEFAULT 0
);
INSERT INTO operations_state(singleton) VALUES(true);
CREATE TABLE operations_hour (
 hour timestamptz PRIMARY KEY,
 requests bigint NOT NULL DEFAULT 0,
 failures bigint NOT NULL DEFAULT 0,
 authorization_denials bigint NOT NULL DEFAULT 0,
 elapsed_ms bigint NOT NULL DEFAULT 0
);
CREATE TABLE operations_counter (
 name text PRIMARY KEY CHECK(name IN ('sign_in_delivered','sign_in_failed','authorization_denials','release_failed','quota_warnings')),
 count bigint NOT NULL DEFAULT 0 CHECK(count>=0),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE operations_alert (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 kind text NOT NULL CHECK(kind='backup_stale'),
 created_at timestamptz NOT NULL DEFAULT now(),
 resolved_at timestamptz,
 delivered_at timestamptz
);
CREATE UNIQUE INDEX one_active_backup_alert ON operations_alert(kind) WHERE resolved_at IS NULL;
CREATE TABLE operations_quota (
 resource text PRIMARY KEY CHECK(resource IN ('database_bytes','storage_bytes','email_monthly','requests_monthly','runtime_ms')),
 used bigint NOT NULL CHECK(used>=0),
 allowance bigint NOT NULL CHECK(allowance>0),
 measured_at timestamptz NOT NULL DEFAULT now()
);
