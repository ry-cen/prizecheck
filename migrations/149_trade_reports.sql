-- Reports and the owner review queue (Trading #303, Stage 2 spec "Reports and the owner review queue";
-- docs/planning/trading/migrations.md). Trading migrations use the reserved block 140-179. Re-runnable (see
-- docs/planning/trading/migrations.md). Purely additive.
--
-- A Report keeps a snapshot the owner reviews: the pair's messages and Trades as they stood when it was filed.
-- Nothing here may block an account's deletion: report parties are SET NULL with names and Handles kept, and the
-- snapshot and moderation tables name no user by foreign key.

CREATE TABLE IF NOT EXISTS trade_report (
  id uuid PRIMARY KEY,
  reporter_id text REFERENCES inventory_owner(user_id) ON DELETE SET NULL,
  reported_id text REFERENCES inventory_owner(user_id) ON DELETE SET NULL,
  reporter_name text NOT NULL,
  reported_name text NOT NULL,
  reporter_handle text NOT NULL,
  reported_handle text NOT NULL,
  reason text NOT NULL CHECK (reason IN ('scam_or_no_show', 'harassment', 'inappropriate_content', 'other')),
  note text CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 1000),
  source text NOT NULL CHECK (source IN ('conversation', 'discovery', 'trade')),
  trade_id uuid,
  conversation_id uuid,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'dismissed', 'actioned')),
  decision text CHECK (decision IN ('dismiss', 'remove_from_discovery', 'suspend')),
  decided_at timestamptz,
  decided_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trade_report_decided CHECK (
    (status = 'open') = (decision IS NULL) AND (status = 'open') = (decided_at IS NULL)
    AND (status <> 'dismissed' OR decision = 'dismiss')
    AND (status <> 'actioned' OR decision IN ('remove_from_discovery', 'suspend')))
);
CREATE INDEX IF NOT EXISTS trade_report_queue ON trade_report (status, created_at);
CREATE INDEX IF NOT EXISTS trade_report_reported ON trade_report (reported_id, created_at);
CREATE INDEX IF NOT EXISTS trade_report_reporter ON trade_report (reporter_id);

CREATE TABLE IF NOT EXISTS trade_report_message (
  report_id uuid NOT NULL REFERENCES trade_report(id) ON DELETE CASCADE,
  message_id uuid NOT NULL,
  from_reporter boolean NOT NULL,
  body text NOT NULL,
  at timestamptz NOT NULL,
  PRIMARY KEY (report_id, message_id)
);

CREATE TABLE IF NOT EXISTS trade_report_trade (
  report_id uuid NOT NULL REFERENCES trade_report(id) ON DELETE CASCADE,
  trade_id uuid NOT NULL,
  facts jsonb NOT NULL,
  PRIMARY KEY (report_id, trade_id)
);

CREATE TABLE IF NOT EXISTS moderation_event (
  id uuid PRIMARY KEY,
  subject_id text,
  subject_name text NOT NULL,
  report_id uuid,
  action text NOT NULL CHECK (action IN ('dismiss', 'remove_from_discovery', 'suspend', 'restore_discovery',
                                         'lift_suspension')),
  owner_id text NOT NULL,
  note text CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS moderation_event_subject ON moderation_event (subject_id, created_at);
CREATE INDEX IF NOT EXISTS moderation_event_report ON moderation_event (report_id);

CREATE OR REPLACE FUNCTION moderation_event_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Moderation events are append-only'; END $$;
DROP TRIGGER IF EXISTS moderation_event_append_only ON moderation_event;
CREATE TRIGGER moderation_event_append_only BEFORE UPDATE OR DELETE ON moderation_event
  FOR EACH ROW EXECUTE FUNCTION moderation_event_append_only();
