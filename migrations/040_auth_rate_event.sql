-- Limits on OAuth account creation and on sign-in and link starts (OAuth spec #147, ticket #155). One table holds both:
-- kind 'signup' is a permitted account creation, kind 'start' a permitted sign-in or link start. ip_key is the sha256
-- of the trusted client IP; there is no email and no raw address. The gateway prunes rows older than two days whenever
-- it writes one. The owner panel reads the last day's signups.
CREATE TABLE auth_rate_event (
  id bigserial PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('signup','start')),
  ip_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_rate_event_kind_ip_time ON auth_rate_event(kind, ip_key, created_at DESC);
CREATE INDEX auth_rate_event_kind_time ON auth_rate_event(kind, created_at DESC);
CREATE INDEX auth_rate_event_time ON auth_rate_event(created_at);
-- A refused creation or start adds to the bounded auth counters.
ALTER TABLE operations_counter DROP CONSTRAINT operations_counter_name_check;
ALTER TABLE operations_counter ADD CONSTRAINT operations_counter_name_check CHECK (name IN ('sign_in_delivered','sign_in_failed','authorization_denials','release_failed','quota_warnings','too_many_sign_ups'));
