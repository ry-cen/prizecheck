-- #478 WP1. Stopped-application cutover in the owner's manual quiet window.
-- Re-runnable: source mappings, message ids and event source keys are stable.
-- No round writer guard: deploy rollback requires restoring the pre-release dump.
CREATE TABLE IF NOT EXISTS thread (
  id uuid PRIMARY KEY, kind text NOT NULL CHECK (kind IN ('trade','loan')),
  user_low text REFERENCES inventory_owner(user_id) ON DELETE SET NULL,
  user_high text REFERENCES inventory_owner(user_id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL, last_activity_at timestamptz NOT NULL, changed_at timestamptz NOT NULL,
  last_from_low_at timestamptz, last_from_high_at timestamptz,
  UNIQUE (id, kind),
  CHECK (user_low IS NULL OR user_high IS NULL OR (user_low COLLATE "C") < (user_high COLLATE "C")));
CREATE INDEX IF NOT EXISTS thread_low ON thread(user_low, last_activity_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS thread_high ON thread(user_high, last_activity_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS thread_pair ON thread(user_low, user_high);
CREATE TABLE IF NOT EXISTS thread_round_source (
  kind text NOT NULL, round_id uuid NOT NULL, thread_id uuid NOT NULL,
  PRIMARY KEY (kind, round_id), FOREIGN KEY (thread_id, kind) REFERENCES thread(id, kind));
CREATE TABLE IF NOT EXISTS thread_member (
  thread_id uuid NOT NULL REFERENCES thread(id),
  member_id text NOT NULL REFERENCES inventory_owner(user_id) ON DELETE CASCADE,
  read_at timestamptz, PRIMARY KEY (thread_id, member_id));
CREATE INDEX IF NOT EXISTS thread_member_member ON thread_member(member_id);
CREATE TABLE IF NOT EXISTS thread_message (
  id uuid PRIMARY KEY, thread_id uuid NOT NULL REFERENCES thread(id), from_low boolean NOT NULL,
  client_key uuid NOT NULL, body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL, UNIQUE (thread_id, from_low, client_key));
CREATE INDEX IF NOT EXISTS thread_message_timeline ON thread_message(thread_id, created_at DESC, id DESC);
CREATE TABLE IF NOT EXISTS thread_event (
  id uuid PRIMARY KEY, thread_id uuid NOT NULL REFERENCES thread(id), actor text CHECK (actor IN ('low','high')),
  kind text NOT NULL, round_id uuid NOT NULL, return_id uuid, data jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL, source_key text UNIQUE);
CREATE INDEX IF NOT EXISTS thread_event_timeline ON thread_event(thread_id, created_at DESC, id DESC);
CREATE TABLE IF NOT EXISTS legacy_contact (
  user_low text REFERENCES inventory_owner(user_id) ON DELETE CASCADE,
  user_high text REFERENCES inventory_owner(user_id) ON DELETE CASCADE,
  PRIMARY KEY (user_low, user_high), CHECK ((user_low COLLATE "C") < (user_high COLLATE "C")));
CREATE INDEX IF NOT EXISTS legacy_contact_high ON legacy_contact(user_high);

-- Only the three migration-147 triggers write the archive. Names on rounds still follow profiles.
DROP TRIGGER IF EXISTS trade_joins_conversation ON trade;
DROP TRIGGER IF EXISTS trade_conversation_activity ON trade;
DROP TRIGGER IF EXISTS trade_names_follow_profile_conversations ON collector_profile;

ALTER TABLE trade ADD COLUMN IF NOT EXISTS thread_id uuid;
ALTER TABLE trade ADD COLUMN IF NOT EXISTS thread_kind text NOT NULL DEFAULT 'trade' CHECK (thread_kind = 'trade');
ALTER TABLE loan ADD COLUMN IF NOT EXISTS thread_id uuid;
ALTER TABLE loan ADD COLUMN IF NOT EXISTS thread_kind text NOT NULL DEFAULT 'loan' CHECK (thread_kind = 'loan');
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='trade'::regclass AND conname='trade_thread') THEN
    ALTER TABLE trade ADD CONSTRAINT trade_thread FOREIGN KEY (thread_id, thread_kind) REFERENCES thread(id, kind);
    ALTER TABLE loan ADD CONSTRAINT loan_thread FOREIGN KEY (thread_id, thread_kind) REFERENCES thread(id, kind);
  END IF;
END $$;

-- Audit the whole historical domain, including Loan-only pairs. Each direction
-- is checked separately; deleted participants deliberately have no reach.
CREATE TEMP TABLE thread_reach_before ON COMMIT DROP AS
WITH pairs AS (
  SELECT user_low AS a,user_high AS b FROM conversation
  UNION SELECT proposer_id,recipient_id FROM trade
  UNION SELECT lender_id,borrower_id FROM loan),
directed AS (SELECT v.viewer,v.other FROM pairs
  CROSS JOIN LATERAL (VALUES(a,b),(b,a)) v(viewer,other) GROUP BY 1,2)
SELECT v.viewer,v.other,r.how,r.band FROM directed v
LEFT JOIN LATERAL trade_reach(v.viewer,ARRAY[v.other]) r ON true;
CREATE INDEX thread_reach_before_pair ON thread_reach_before(viewer,other);
ANALYZE thread_reach_before;

-- Prepare the source before traversing: a long single chain otherwise repeats
-- a full trade scan at every recursive step. Loans have no retained chain link;
-- each Loan is its own root in thread_rounds below.
CREATE INDEX IF NOT EXISTS trade_counter_chain ON trade(countered_from);
ANALYZE trade;
ANALYZE loan;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM trade WHERE countered_from IS NOT NULL GROUP BY countered_from HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'nonlinear_counter_chain';
  END IF;
END $$;
CREATE TEMP TABLE thread_chains ON COMMIT DROP AS
WITH RECURSIVE chain AS (
  SELECT id, id AS root FROM trade WHERE countered_from IS NULL
  UNION ALL SELECT t.id, c.root FROM trade t JOIN chain c ON t.countered_from=c.id)
SELECT * FROM chain;
CREATE UNIQUE INDEX thread_chains_id ON thread_chains(id);
CREATE INDEX thread_chains_root ON thread_chains(root);
ANALYZE thread_chains;
DO $$ BEGIN
  IF (SELECT count(*) FROM thread_chains) <> (SELECT count(*) FROM trade) THEN
    RAISE EXCEPTION 'nonlinear_counter_chain: cycle';
  END IF;
END $$;

-- A normalized snapshot is only migration working data, never an application schema.
CREATE TEMP TABLE thread_rounds ON COMMIT DROP AS
SELECT 'trade'::text AS kind, t.id, c.root, t.proposer_id AS a, t.recipient_id AS b,
  t.created_at, t.state, t.closed_at,
  greatest(t.created_at,t.accepted_at,t.proposer_swap_at,t.recipient_swap_at,t.closed_at) AS activity,
  coalesce(t.conversation_id,archive.id) AS conversation_id, to_jsonb(t) AS facts
FROM trade t JOIN thread_chains c ON c.id=t.id
LEFT JOIN conversation archive ON t.proposer_id IS NOT NULL AND t.recipient_id IS NOT NULL
  AND archive.user_low=CASE WHEN (t.proposer_id COLLATE "C")<(t.recipient_id COLLATE "C") THEN t.proposer_id ELSE t.recipient_id END
  AND archive.user_high=CASE WHEN (t.proposer_id COLLATE "C")<(t.recipient_id COLLATE "C") THEN t.recipient_id ELSE t.proposer_id END
UNION ALL
SELECT 'loan', l.id, l.id, l.lender_id, l.borrower_id, l.created_at, l.state, l.closed_at,
  greatest(l.created_at,l.accepted_at,l.lender_handover_at,l.borrower_handover_at,l.closed_at),
  c.id, to_jsonb(l)
FROM loan l LEFT JOIN conversation c ON l.lender_id IS NOT NULL AND l.borrower_id IS NOT NULL
  AND c.user_low=CASE WHEN (l.lender_id COLLATE "C") < (l.borrower_id COLLATE "C") THEN l.lender_id ELSE l.borrower_id END
  AND c.user_high=CASE WHEN (l.lender_id COLLATE "C") < (l.borrower_id COLLATE "C") THEN l.borrower_id ELSE l.lender_id END;
-- A deleted Loan side cannot be inferred from names or the survivor alone.
-- A retained closing actor proves the deleted identity only when a Trade's
-- explicit archive FK witnesses that same identity and survivor. Require exactly
-- one candidate archive for the survivor across BOTH possible archived slots.
CREATE TEMP TABLE thread_deleted_archives ON COMMIT DROP AS
SELECT coalesce(user_low,user_high) AS survivor,min(id::text)::uuid AS conversation_id
FROM conversation WHERE (user_low IS NULL) <> (user_high IS NULL)
GROUP BY 1 HAVING count(*)=1;
CREATE UNIQUE INDEX thread_deleted_archives_survivor ON thread_deleted_archives(survivor);
ANALYZE thread_deleted_archives;
UPDATE thread_rounds r SET conversation_id=c.id
FROM thread_deleted_archives d JOIN conversation c ON c.id=d.conversation_id
WHERE r.kind='loan' AND (r.a IS NULL)<>(r.b IS NULL)
  AND d.survivor=coalesce(r.a,r.b)
  AND r.facts->>'closed_by' IS NOT NULL AND r.facts->>'closed_by'<>d.survivor
  AND NOT EXISTS (SELECT 1 FROM inventory_owner WHERE user_id=r.facts->>'closed_by')
  AND EXISTS (SELECT 1 FROM trade witness WHERE witness.conversation_id=c.id
    AND witness.closed_by=r.facts->>'closed_by'
    AND (witness.proposer_id IS NULL)<>(witness.recipient_id IS NULL)
    AND coalesce(witness.proposer_id,witness.recipient_id)=d.survivor);
CREATE UNIQUE INDEX thread_rounds_identity ON thread_rounds(kind,id);
CREATE INDEX thread_rounds_root ON thread_rounds(kind,root);
CREATE INDEX thread_rounds_archive ON thread_rounds(conversation_id);
ANALYZE thread_rounds;
DO $$ DECLARE n bigint; BEGIN
  SELECT count(*) INTO n FROM thread_rounds WHERE kind='loan' AND (a IS NULL OR b IS NULL) AND conversation_id IS NULL;
  RAISE NOTICE 'thread backfill: % deleted-participant Loan rounds have no proven archive association; messages and read markers stay archived',n;
END $$;
DO $$
DECLARE r record; tid uuid; lo text; hi text;
BEGIN
  FOR r IN SELECT * FROM thread_rounds WHERE id=root ORDER BY kind,id LOOP
    SELECT thread_id INTO tid FROM thread_round_source WHERE kind=r.kind AND round_id=r.id;
    IF tid IS NULL THEN
      -- Deleted slots follow the root round's own columns (a=low,b=high).
      -- Live slots retain byte order. Archive senders are normalized below.
      IF r.a IS NULL OR r.b IS NULL THEN
        lo := r.a; hi := r.b;
      ELSE
        lo := CASE WHEN (r.a COLLATE "C")<(r.b COLLATE "C") THEN r.a ELSE r.b END;
        hi := CASE WHEN lo=r.a THEN r.b ELSE r.a END;
      END IF;
      tid := gen_random_uuid();
      INSERT INTO thread(id,kind,user_low,user_high,created_at,last_activity_at,changed_at)
        VALUES(tid,r.kind,lo,hi,r.created_at,r.activity,r.activity);
    END IF;
    INSERT INTO thread_round_source(kind,round_id,thread_id)
      SELECT kind,id,tid FROM thread_rounds WHERE kind=r.kind AND root=r.root ON CONFLICT DO NOTHING;
  END LOOP;
END $$;
UPDATE trade t SET thread_id=s.thread_id FROM thread_round_source s
WHERE s.kind='trade' AND s.round_id=t.id AND t.thread_id IS NULL;
UPDATE loan l SET thread_id=s.thread_id FROM thread_round_source s
WHERE s.kind='loan' AND s.round_id=l.id AND l.thread_id IS NULL;

-- Existing rounds must satisfy the same pair invariant as future INSERTs.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM thread_rounds r
    JOIN thread_round_source s ON s.kind=r.kind AND s.round_id=r.id
    JOIN thread t ON t.id=s.thread_id
    WHERE (SELECT array_agg(u ORDER BY u COLLATE "C") FROM unnest(ARRAY[r.a,r.b]) u WHERE u IS NOT NULL)
      IS DISTINCT FROM
      (SELECT array_agg(u ORDER BY u COLLATE "C") FROM unnest(ARRAY[t.user_low,t.user_high]) u WHERE u IS NOT NULL)) THEN
    RAISE EXCEPTION 'round_in_thread_pair: backfill';
  END IF;
END $$;

CREATE TEMP TABLE thread_spans ON COMMIT DROP AS
SELECT t.id, t.created_at AS opened_at,
  CASE WHEN bool_or(r.state <> 'closed') THEN NULL ELSE
    max(CASE WHEN r.kind='loan' OR NOT EXISTS (SELECT 1 FROM trade next WHERE next.countered_from=r.id)
      THEN coalesce(r.closed_at,r.activity) END) END AS closed_at,
  max(r.activity) AS activity
FROM thread t JOIN thread_round_source s ON s.thread_id=t.id
JOIN thread_rounds r ON r.kind=s.kind AND r.id=s.round_id GROUP BY t.id;
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT rr.* FROM thread_rounds rr WHERE state='closed' AND closed_at IS NULL
    AND (kind='loan' OR NOT EXISTS (SELECT 1 FROM trade n WHERE n.countered_from=rr.id)) LOOP
    RAISE WARNING 'thread backfill: closed % tip % has NULL closed_at; using %',r.kind,r.id,r.activity;
  END LOOP;
END $$;

CREATE TEMP TABLE thread_archive_source ON COMMIT DROP AS
SELECT DISTINCT s.thread_id,r.conversation_id,
  CASE WHEN c.user_low IS NOT NULL THEN c.user_low=t.user_low
       WHEN c.user_high IS NOT NULL THEN c.user_high IS NOT DISTINCT FROM t.user_high
       ELSE true END AS same_slots
FROM thread_rounds r JOIN thread_round_source s ON s.kind=r.kind AND s.round_id=r.id
JOIN thread t ON t.id=s.thread_id JOIN conversation c ON c.id=r.conversation_id
WHERE t.user_low IS NOT NULL OR t.user_high IS NOT NULL;
CREATE UNIQUE INDEX thread_archive_source_pair ON thread_archive_source(conversation_id,thread_id);
CREATE INDEX thread_archive_source_thread ON thread_archive_source(thread_id);
ANALYZE thread_archive_source;
CREATE UNIQUE INDEX thread_spans_id ON thread_spans(id);
ANALYZE thread_spans;

-- M1, across both kinds. DISTINCT ON chooses one destination per source message.
INSERT INTO thread_message(id,thread_id,from_low,client_key,body,created_at)
SELECT DISTINCT ON (m.id) m.id,t.id,
  CASE WHEN src.same_slots THEN m.from_low ELSE NOT m.from_low END,m.client_key,m.body,m.created_at
FROM message m JOIN thread_archive_source src ON src.conversation_id=m.conversation_id
JOIN thread t ON t.id=src.thread_id JOIN thread_spans s ON s.id=t.id
ORDER BY m.id,
  CASE WHEN s.opened_at<=m.created_at AND (s.closed_at IS NULL OR s.closed_at>=m.created_at) THEN 0
       WHEN s.closed_at<m.created_at THEN 1 ELSE 2 END,
  CASE WHEN s.opened_at<=m.created_at AND (s.closed_at IS NULL OR s.closed_at>=m.created_at) THEN s.opened_at END DESC,
  CASE WHEN s.closed_at<m.created_at THEN s.closed_at END DESC,
  CASE WHEN s.opened_at>m.created_at THEN s.opened_at END ASC,
  CASE t.kind WHEN 'trade' THEN 0 ELSE 1 END,t.id
ON CONFLICT DO NOTHING;
DO $$ DECLARE n bigint; BEGIN
  SELECT count(*) INTO n FROM message m WHERE NOT EXISTS (SELECT 1 FROM thread_message tm WHERE tm.id=m.id);
  RAISE NOTICE 'thread backfill: % source messages remain archive-only (no proven destination)',n;
END $$;
UPDATE thread t SET last_activity_at=greatest(t.last_activity_at,s.activity,m.last_at),
  changed_at=greatest(t.changed_at,s.activity,m.last_at),
  last_from_low_at=m.low_at,last_from_high_at=m.high_at
FROM thread_spans s LEFT JOIN LATERAL (
  SELECT max(created_at) AS last_at,max(created_at) FILTER(WHERE from_low) AS low_at,
    max(created_at) FILTER(WHERE NOT from_low) AS high_at FROM thread_message WHERE thread_id=s.id) m ON true
WHERE t.id=s.id;
INSERT INTO thread_member(thread_id,member_id,read_at)
SELECT t.id,u.member,CASE WHEN c.id IS NULL THEN t.last_activity_at ELSE cm.read_at END
FROM thread t CROSS JOIN LATERAL (VALUES(t.user_low),(t.user_high)) u(member)
LEFT JOIN LATERAL (SELECT conversation_id AS id FROM thread_archive_source
  WHERE thread_id=t.id ORDER BY conversation_id LIMIT 1) c ON true
LEFT JOIN conversation_member cm ON cm.conversation_id=c.id AND cm.member_id=u.member
WHERE u.member IS NOT NULL ON CONFLICT DO NOTHING;

INSERT INTO legacy_contact(user_low,user_high)
SELECT c.user_low,c.user_high FROM conversation c WHERE c.user_low IS NOT NULL AND c.user_high IS NOT NULL
AND NOT EXISTS (SELECT 1 FROM thread t WHERE t.user_low=c.user_low AND t.user_high=c.user_high)
ON CONFLICT DO NOTHING;

-- Slot-based line snapshots and differences; no private inventory facts enter events.
CREATE TEMP TABLE thread_lines ON COMMIT DROP AS
SELECT r.kind,r.id,t.id AS thread_id,l.edition_id,l.quantity,
  CASE WHEN (l.side='proposer') = (r.a IS NOT DISTINCT FROM t.user_low) THEN 'low' ELSE 'high' END AS giver
FROM thread_rounds r JOIN thread_round_source s ON s.kind=r.kind AND s.round_id=r.id
JOIN thread t ON t.id=s.thread_id JOIN trade_line l ON r.kind='trade' AND l.trade_id=r.id
UNION ALL
SELECT r.kind,r.id,t.id,l.edition_id,l.requested,
  CASE WHEN r.a IS NOT DISTINCT FROM t.user_low THEN 'low' ELSE 'high' END
FROM thread_rounds r JOIN thread_round_source s ON s.kind=r.kind AND s.round_id=r.id
JOIN thread t ON t.id=s.thread_id JOIN loan_line l ON r.kind='loan' AND l.loan_id=r.id;
CREATE INDEX thread_lines_round ON thread_lines(kind,id);
ANALYZE thread_lines;
CREATE TEMP TABLE thread_open_data ON COMMIT DROP AS
SELECT r.kind,r.id,jsonb_build_object('lines',coalesce(d.lines,'[]'::jsonb)) ||
  CASE WHEN r.kind='trade' THEN jsonb_build_object('cash',jsonb_build_object(
    'from',jsonb_build_object('cents',coalesce((prev.cash_cents),0),'payer',
      CASE WHEN prev.cash_payer IS NULL THEN NULL
        WHEN (prev.cash_payer='proposer')=(prev.proposer_id IS NOT DISTINCT FROM t.user_low) THEN 'low' ELSE 'high' END),
    'to',jsonb_build_object('cents',(r.facts->>'cash_cents')::bigint,'payer',
      CASE WHEN r.facts->>'cash_payer' IS NULL THEN NULL
        WHEN (r.facts->>'cash_payer'='proposer')=(r.a IS NOT DISTINCT FROM t.user_low) THEN 'low' ELSE 'high' END)))
  ELSE jsonb_build_object('return_by',jsonb_build_object('from',NULL,'to',r.facts->>'return_by')) END AS data
FROM thread_rounds r JOIN thread_round_source s ON s.kind=r.kind AND s.round_id=r.id
JOIN thread t ON t.id=s.thread_id LEFT JOIN trade prev ON r.kind='trade' AND prev.id=(r.facts->>'countered_from')::uuid
LEFT JOIN LATERAL (
  SELECT jsonb_agg(jsonb_build_object('giver',coalesce(n.giver,o.giver),'edition_id',coalesce(n.edition_id,o.edition_id),
    'from_qty',coalesce(o.quantity,0),'to_qty',coalesce(n.quantity,0)) ORDER BY coalesce(n.giver,o.giver),coalesce(n.edition_id,o.edition_id)) AS lines
  FROM (SELECT * FROM thread_lines WHERE kind=r.kind AND id=r.id) n
  FULL JOIN (SELECT * FROM thread_lines WHERE kind='trade' AND id=prev.id) o USING(giver,edition_id)
  WHERE coalesce(n.quantity,0)<>coalesce(o.quantity,0)) d ON true;
INSERT INTO thread_event(id,thread_id,actor,kind,round_id,data,created_at,source_key)
SELECT gen_random_uuid(),s.thread_id,
  CASE WHEN r.kind='loan' AND r.facts->>'kind'='borrow_request'
    THEN CASE WHEN r.b IS NOT DISTINCT FROM t.user_low THEN 'low' ELSE 'high' END
    ELSE CASE WHEN r.a IS NOT DISTINCT FROM t.user_low THEN 'low' ELSE 'high' END END,
  CASE WHEN r.kind='trade' THEN CASE WHEN r.id=r.root THEN 'offered' ELSE 'countered' END
       WHEN r.facts->>'kind'='borrow_request' THEN 'requested' ELSE 'offered' END,
  r.id,d.data,r.created_at,(CASE WHEN r.kind='trade' THEN CASE WHEN r.id=r.root THEN 'offered' ELSE 'countered' END WHEN r.facts->>'kind'='borrow_request' THEN 'requested' ELSE 'offered' END)||':'||r.kind||':'||r.id
FROM thread_rounds r JOIN thread_round_source s ON s.kind=r.kind AND s.round_id=r.id
JOIN thread t ON t.id=s.thread_id JOIN thread_open_data d ON d.kind=r.kind AND d.id=r.id
ON CONFLICT DO NOTHING;
-- Only persisted step times can be reconstructed; edits without history are not invented.
INSERT INTO thread_event(id,thread_id,actor,kind,round_id,data,created_at,source_key)
SELECT gen_random_uuid(),t.id,e.actor,e.kind,r.id,
  CASE WHEN e.kind='partly_accepted' THEN jsonb_build_object('not_lent',
    (SELECT jsonb_agg(jsonb_build_object('edition_id',edition_id,'quantity',requested-promised) ORDER BY edition_id)
      FROM loan_line WHERE loan_id=r.id AND requested>promised)) ELSE '{}'::jsonb END,
  e.at,e.kind||':'||r.kind||':'||r.id||':'||coalesce(e.actor,'app')
FROM thread_rounds r JOIN thread_round_source s ON s.kind=r.kind AND s.round_id=r.id
JOIN thread t ON t.id=s.thread_id
CROSS JOIN LATERAL (VALUES
  (CASE WHEN r.kind='loan' AND EXISTS (SELECT 1 FROM loan_line WHERE loan_id=r.id AND requested>promised)
    THEN 'partly_accepted' ELSE 'accepted' END,
    CASE WHEN r.kind='trade' OR r.facts->>'kind'='lend_offer' THEN r.b ELSE r.a END, (r.facts->>'accepted_at')::timestamptz),
  ('handed_over',NULL,CASE WHEN r.facts->>'lender_handover_at' IS NOT NULL AND r.facts->>'borrower_handover_at' IS NOT NULL
    THEN greatest((r.facts->>'lender_handover_at')::timestamptz,(r.facts->>'borrower_handover_at')::timestamptz) END),
  ('swap_confirmed',r.a,(r.facts->>'proposer_swap_at')::timestamptz),
  ('swap_confirmed',r.b,(r.facts->>'recipient_swap_at')::timestamptz),
  ('handover_confirmed',r.a,(r.facts->>'lender_handover_at')::timestamptz),
  ('handover_confirmed',r.b,(r.facts->>'borrower_handover_at')::timestamptz)
) v(kind,who,at)
CROSS JOIN LATERAL (SELECT v.kind, v.at,
  CASE WHEN v.kind='handed_over' THEN NULL WHEN v.who IS NOT DISTINCT FROM t.user_low THEN 'low' ELSE 'high' END AS actor) e
WHERE e.at IS NOT NULL ON CONFLICT DO NOTHING;
INSERT INTO thread_event(id,thread_id,actor,kind,round_id,created_at,source_key)
SELECT gen_random_uuid(),s.thread_id,
  CASE WHEN r.facts->>'closed_by' IS NULL THEN NULL
    WHEN r.facts->>'closed_by'=t.user_low THEN 'low' WHEN r.facts->>'closed_by'=t.user_high THEN 'high' END,
  CASE WHEN r.facts->>'closed_reason' IN ('declined','withdrawn','swapped','returned','written_off') THEN r.facts->>'closed_reason'
    WHEN r.facts->>'closed_reason' IN ('blocked','unfriended','suspended') THEN 'closed_'||(r.facts->>'closed_reason')
    ELSE 'cancelled' END,
  r.id,r.closed_at,'closed:'||r.kind||':'||r.id
FROM thread_rounds r JOIN thread_round_source s ON s.kind=r.kind AND s.round_id=r.id JOIN thread t ON t.id=s.thread_id
WHERE r.state='closed' AND r.closed_at IS NOT NULL AND r.facts->>'closed_reason'<>'countered'
ON CONFLICT DO NOTHING;
INSERT INTO thread_event(id,thread_id,actor,kind,round_id,return_id,data,created_at,source_key)
SELECT gen_random_uuid(),s.thread_id,
  CASE WHEN v.side='app' THEN NULL WHEN v.who IS NOT DISTINCT FROM t.user_low THEN 'low' ELSE 'high' END,v.kind,l.id,ret.id,
  jsonb_build_object('returned',coalesce((SELECT jsonb_agg(jsonb_build_object('edition_id',edition_id,'quantity',quantity) ORDER BY edition_id)
    FROM loan_return_line WHERE return_id=ret.id),'[]'::jsonb)),v.at,v.kind||':loan:'||l.id||':'||ret.id||':'||v.side
FROM loan_return ret JOIN loan l ON l.id=ret.loan_id JOIN thread_round_source s ON s.kind='loan' AND s.round_id=l.id
JOIN thread t ON t.id=s.thread_id
CROSS JOIN LATERAL (VALUES
 ('return_recorded',ret.started_by,CASE WHEN ret.started_by='lender' THEN l.lender_id ELSE l.borrower_id END,ret.created_at),
 ('return_confirmed','lender',l.lender_id,ret.lender_confirmed_at),
 ('return_confirmed','borrower',l.borrower_id,ret.borrower_confirmed_at)) v(kind,side,who,at)
WHERE v.at IS NOT NULL ON CONFLICT DO NOTHING;
CREATE OR REPLACE FUNCTION trade_reach(viewer text, others text[])
RETURNS TABLE(other_id text, how text, band smallint) LANGUAGE sql STABLE AS $$
  SELECT o.id,
         CASE WHEN f.friend_id IS NOT NULL THEN 'friend' WHEN c.present IS NOT NULL THEN 'conversation' ELSE 'near' END,
         CASE WHEN f.friend_id IS NULL THEN distance_band(dv.lat, dv.lon, d.lat, d.lon) END
  FROM unnest(others) AS o(id)
  JOIN collector_profile p ON p.user_id = o.id AND p.suspended_at IS NULL
  JOIN collector_profile me ON me.user_id = viewer AND me.suspended_at IS NULL
  LEFT JOIN friends_of(ARRAY[viewer]) f ON f.friend_id = o.id
  LEFT JOIN LATERAL (
    SELECT true AS present WHERE EXISTS (
      SELECT 1 FROM thread t
      WHERE t.user_low = CASE WHEN (viewer COLLATE "C") < (o.id COLLATE "C") THEN viewer ELSE o.id END
        AND t.user_high = CASE WHEN (viewer COLLATE "C") < (o.id COLLATE "C") THEN o.id ELSE viewer END)
      OR EXISTS (SELECT 1 FROM legacy_contact l
      WHERE l.user_low = CASE WHEN (viewer COLLATE "C") < (o.id COLLATE "C") THEN viewer ELSE o.id END
        AND l.user_high = CASE WHEN (viewer COLLATE "C") < (o.id COLLATE "C") THEN o.id ELSE viewer END)
  ) c ON true
  LEFT JOIN open_discovery dv ON dv.user_id = viewer
  LEFT JOIN open_discovery d ON d.user_id = o.id
  WHERE o.id <> viewer
    AND NOT EXISTS (SELECT 1 FROM block b WHERE (b.blocker_id = viewer AND b.blocked_id = o.id)
                                             OR (b.blocker_id = o.id AND b.blocked_id = viewer))
    AND (f.friend_id IS NOT NULL OR c.present IS NOT NULL OR distance_band(dv.lat, dv.lon, d.lat, d.lon) IS NOT NULL)
$$;

-- Only the intended promotion to thread reach is allowed: absent/near ->
-- conversation, with a shared thread. Losses, demotions, unrelated gains and
-- distance drift all abort the migration transaction.
CREATE TEMP TABLE thread_reach_changes ON COMMIT DROP AS
SELECT b.*,r.how AS new_how,r.band AS new_band,
  EXISTS (SELECT 1 FROM thread t
    WHERE t.user_low=CASE WHEN (b.viewer COLLATE "C")<(b.other COLLATE "C") THEN b.viewer ELSE b.other END
      AND t.user_high=CASE WHEN (b.viewer COLLATE "C")<(b.other COLLATE "C") THEN b.other ELSE b.viewer END) AS shared_thread
FROM thread_reach_before b LEFT JOIN LATERAL trade_reach(b.viewer,ARRAY[b.other]) r ON true
WHERE (b.how,b.band) IS DISTINCT FROM (r.how,r.band);
DO $$ DECLARE n bigint; gained record; BEGIN
  IF EXISTS (SELECT 1 FROM thread_reach_changes WHERE NOT (
    (how IS NULL OR how='near') AND new_how IS NOT DISTINCT FROM 'conversation' AND shared_thread
    AND band IS NOT DISTINCT FROM new_band)) THEN
    RAISE EXCEPTION 'thread_reach_changed';
  END IF;
  SELECT count(*) INTO n FROM thread_reach_changes;
  RAISE NOTICE 'thread reach exception: % directed answers (% pairs) gained conversation reach through a shared thread',n,n/2;
  FOR gained IN SELECT * FROM thread_reach_changes WHERE (viewer COLLATE "C")<(other COLLATE "C") LOOP
    RAISE NOTICE 'thread reach allowed gain: pair (%, %), % -> conversation, shared thread',gained.viewer,gained.other,coalesce(gained.how,'none');
  END LOOP;
END $$;
ALTER TABLE trade ALTER COLUMN thread_id SET NOT NULL;
ALTER TABLE loan ALTER COLUMN thread_id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS trade_one_live ON trade(thread_id) WHERE state<>'closed';
CREATE UNIQUE INDEX IF NOT EXISTS loan_one_live ON loan(thread_id) WHERE state<>'closed';

CREATE OR REPLACE FUNCTION thread_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_row jsonb := to_jsonb(OLD); new_row jsonb := to_jsonb(NEW); col text;
BEGIN
  FOREACH col IN ARRAY CASE WHEN TG_TABLE_NAME='thread' THEN ARRAY['id','kind'] ELSE ARRAY['thread_id','thread_kind'] END LOOP
    IF old_row->col IS DISTINCT FROM new_row->col THEN RAISE EXCEPTION 'round_thread_immutable'; END IF;
  END LOOP;
  FOREACH col IN ARRAY TG_ARGV LOOP
    IF old_row->col IS DISTINCT FROM new_row->col AND
      (new_row->>col IS NOT NULL OR EXISTS (SELECT 1 FROM inventory_owner WHERE user_id=old_row->>col)) THEN
      RAISE EXCEPTION 'participant_immutable';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS thread_immutable ON trade;
CREATE TRIGGER thread_immutable BEFORE UPDATE OF thread_id,thread_kind,proposer_id,recipient_id ON trade
FOR EACH ROW EXECUTE FUNCTION thread_immutable('proposer_id','recipient_id');
DROP TRIGGER IF EXISTS thread_immutable ON loan;
CREATE TRIGGER thread_immutable BEFORE UPDATE OF thread_id,thread_kind,lender_id,borrower_id ON loan
FOR EACH ROW EXECUTE FUNCTION thread_immutable('lender_id','borrower_id');
DROP TRIGGER IF EXISTS thread_immutable ON thread;
CREATE TRIGGER thread_immutable BEFORE UPDATE OF id,kind,user_low,user_high ON thread
FOR EACH ROW EXECUTE FUNCTION thread_immutable('user_low','user_high');

CREATE OR REPLACE FUNCTION round_in_thread_pair() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r jsonb; pair text[]; actual text[]; tid uuid;
BEGIN
  -- Read the final row, not the INSERT image: an account may be deleted later in
  -- this transaction, and the SET NULL cascade must be visible at commit.
  EXECUTE format('SELECT to_jsonb(r) FROM %I r WHERE id=$1',TG_TABLE_NAME) INTO r USING NEW.id;
  IF r IS NULL THEN RETURN NULL; END IF;
  tid := (r->>'thread_id')::uuid;
  SELECT array_agg(u ORDER BY u COLLATE "C") INTO pair FROM thread t,
    LATERAL unnest(ARRAY[t.user_low,t.user_high]) u WHERE t.id=tid AND u IS NOT NULL;
  SELECT array_agg(u ORDER BY u COLLATE "C") INTO actual FROM
    unnest(ARRAY[r->>TG_ARGV[0],r->>TG_ARGV[1]]) u WHERE u IS NOT NULL;
  IF pair IS DISTINCT FROM actual THEN RAISE EXCEPTION 'round_in_thread_pair'; END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS round_in_thread_pair ON trade;
CREATE CONSTRAINT TRIGGER round_in_thread_pair AFTER INSERT ON trade DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION round_in_thread_pair('proposer_id','recipient_id');
DROP TRIGGER IF EXISTS round_in_thread_pair ON loan;
CREATE CONSTRAINT TRIGGER round_in_thread_pair AFTER INSERT ON loan DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION round_in_thread_pair('lender_id','borrower_id');

CREATE OR REPLACE FUNCTION conversation_archived() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE col text; o jsonb; n jsonb;
BEGIN
  IF TG_TABLE_NAME='conversation_member' AND TG_OP='DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM inventory_owner WHERE user_id=OLD.member_id) THEN RETURN OLD; END IF;
  END IF;
  IF TG_TABLE_NAME='conversation' AND TG_OP='UPDATE' THEN
    o := to_jsonb(OLD); n := to_jsonb(NEW);
    IF (o-ARRAY['user_low','user_high']) = (n-ARRAY['user_low','user_high']) THEN
      FOREACH col IN ARRAY ARRAY['user_low','user_high'] LOOP
        IF o->col IS DISTINCT FROM n->col AND
          (n->>col IS NOT NULL OR EXISTS (SELECT 1 FROM inventory_owner WHERE user_id=o->>col)) THEN
          RAISE EXCEPTION 'conversation_archived';
        END IF;
      END LOOP;
      -- At least one slot must actually change: a direct no-op update is a write.
      IF (o->'user_low',o->'user_high') IS DISTINCT FROM (n->'user_low',n->'user_high') THEN RETURN NEW; END IF;
    END IF;
  END IF;
  RAISE EXCEPTION 'conversation_archived';
END $$;
DROP TRIGGER IF EXISTS conversation_archived ON conversation;
CREATE TRIGGER conversation_archived BEFORE INSERT OR UPDATE OR DELETE ON conversation
FOR EACH ROW EXECUTE FUNCTION conversation_archived();
DROP TRIGGER IF EXISTS conversation_archived ON conversation_member;
CREATE TRIGGER conversation_archived BEFORE INSERT OR UPDATE OR DELETE ON conversation_member
FOR EACH ROW EXECUTE FUNCTION conversation_archived();
DROP TRIGGER IF EXISTS conversation_archived ON message;
CREATE TRIGGER conversation_archived BEFORE INSERT OR UPDATE OR DELETE ON message
FOR EACH ROW EXECUTE FUNCTION conversation_archived();
