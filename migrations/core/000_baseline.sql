-- Core baseline (S10, IM-13 option A): the shared tables, functions, views and triggers of the schema that migrations
-- 001 to 162 leave, minus everything Pokemon or auth owns. A new game's database starts here, then applies the core tail
-- (core/002 and later) and its own game track. The Pokemon database never runs this file: its runner records it, with
-- core/001_zip_centroids.sql, after checking that these objects exist (scripts/migrate.py, scripts/migration_tracks.py).
--
-- What is left out, on purpose:
--  * every catalog_* relation and the other Pokemon relations (price, TCGplayer, scanner), and the functions and triggers
--    that serve them;
--  * the 16 foreign keys from core tables into catalog_edition and catalog_printing: a game track adds them once it has
--    created its own catalog tables (api/tests/core_baseline_ownership.py lists them, and the stub game track in
--    api/tests/fixtures/stub_game_track adds them back);
--  * the auth objects (user, session, account, verification, auth_rate_event, auth_send_event, owner_binding and the
--    onboard_auth_account trigger), which the auth track will own.
-- released_handle and legacy_contact stay: core functions and core API code read them.
--
-- Cut from the Pokemon schema with pg_dump 16 and tidied (qualifiers, owners and settings removed, objects ordered
-- tables, functions, constraints, indexes, foreign keys, views, triggers). api/tests/test_core_baseline.py proves that
-- every object here is defined exactly as the Pokemon history defines it, so this file is checked, not trusted.
-- Never edit this file once it reaches dev: later core changes are new core/NNN files.

-- TABLE: art_fetch_failure

CREATE TABLE art_fetch_failure (
    printing_id uuid NOT NULL,
    size text NOT NULL,
    source_url text NOT NULL,
    failures integer NOT NULL,
    last_failed_at timestamp with time zone NOT NULL,
    reason text NOT NULL,
    CONSTRAINT art_fetch_failure_failures_check CHECK ((failures >= 1)),
    CONSTRAINT art_fetch_failure_reason_check CHECK ((reason = ANY (ARRAY['status'::text, 'timeout'::text, 'transport'::text, 'redirect'::text, 'content_type'::text, 'too_large'::text, 'magic'::text]))),
    CONSTRAINT art_fetch_failure_size_check CHECK ((size = ANY (ARRAY['small'::text, 'large'::text])))
);

-- TABLE: art_hit

CREATE TABLE art_hit (
    printing_id uuid NOT NULL,
    size text NOT NULL,
    hits bigint NOT NULL,
    last_hit_at timestamp with time zone NOT NULL,
    CONSTRAINT art_hit_hits_check CHECK ((hits >= 1)),
    CONSTRAINT art_hit_size_check CHECK ((size = ANY (ARRAY['small'::text, 'large'::text])))
);

-- TABLE: art_large_upgrade

CREATE TABLE art_large_upgrade (
    printing_id uuid NOT NULL,
    candidate_url text NOT NULL,
    base_url text NOT NULL,
    outcome text NOT NULL,
    width integer,
    height integer,
    failures integer DEFAULT 0 NOT NULL,
    reason text,
    checked_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT art_large_upgrade_base_url_check CHECK (((length(base_url) >= 1) AND (length(base_url) <= 2048))),
    CONSTRAINT art_large_upgrade_candidate_url_check CHECK (((length(candidate_url) >= 1) AND (length(candidate_url) <= 2048))),
    CONSTRAINT art_large_upgrade_check CHECK (((outcome = 'failed'::text) = (reason IS NOT NULL))),
    CONSTRAINT art_large_upgrade_check1 CHECK (((outcome = 'failed'::text) = (failures >= 1))),
    CONSTRAINT art_large_upgrade_check2 CHECK (((outcome <> 'won'::text) OR ((width IS NOT NULL) AND (height IS NOT NULL)))),
    CONSTRAINT art_large_upgrade_failures_check CHECK ((failures >= 0)),
    CONSTRAINT art_large_upgrade_height_check CHECK (((height >= 1) AND (height <= 65535))),
    CONSTRAINT art_large_upgrade_outcome_check CHECK ((outcome = ANY (ARRAY['won'::text, 'lost'::text, 'failed'::text]))),
    CONSTRAINT art_large_upgrade_reason_check CHECK ((reason = ANY (ARRAY['status'::text, 'timeout'::text, 'transport'::text, 'redirect'::text, 'content_type'::text, 'too_large'::text, 'magic'::text]))),
    CONSTRAINT art_large_upgrade_width_check CHECK (((width >= 1) AND (width <= 65535)))
);

-- TABLE: art_object

CREATE TABLE art_object (
    printing_id uuid NOT NULL,
    size text NOT NULL,
    source_url text NOT NULL,
    storage_key text NOT NULL,
    sha256 text NOT NULL,
    content_type text NOT NULL,
    byte_size integer NOT NULL,
    stored_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT art_object_byte_size_check CHECK (((byte_size >= 1) AND (byte_size <= 2097152))),
    CONSTRAINT art_object_content_type_check CHECK ((content_type = ANY (ARRAY['image/webp'::text, 'image/png'::text, 'image/jpeg'::text]))),
    CONSTRAINT art_object_sha256_check CHECK ((sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT art_object_size_check CHECK ((size = ANY (ARRAY['small'::text, 'large'::text]))),
    CONSTRAINT art_object_source_url_check CHECK (((length(source_url) >= 1) AND (length(source_url) <= 2048))),
    CONSTRAINT art_object_storage_key_check CHECK ((length(storage_key) <= 255))
);

-- TABLE: block

CREATE TABLE block (
    blocker_id text NOT NULL,
    blocked_id text NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    via text DEFAULT 'collector'::text NOT NULL,
    handle_shown boolean DEFAULT false NOT NULL,
    CONSTRAINT block_not_self CHECK ((blocker_id <> blocked_id)),
    CONSTRAINT block_via CHECK ((via = ANY (ARRAY['collector'::text, 'trader'::text])))
);

-- TABLE: borrowed_holding

CREATE TABLE borrowed_holding (
    id bigint NOT NULL,
    loan_id uuid NOT NULL,
    borrower_id text NOT NULL,
    location_id uuid NOT NULL,
    edition_id uuid NOT NULL,
    quantity bigint NOT NULL,
    CONSTRAINT borrowed_holding_quantity_check CHECK ((quantity > 0))
);

-- SEQUENCE: borrowed_holding_id_seq

CREATE SEQUENCE borrowed_holding_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

-- TABLE: collection_import

CREATE TABLE collection_import (
    id uuid NOT NULL,
    owner_id text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    location_id uuid NOT NULL,
    excluded_groups jsonb DEFAULT '[]'::jsonb NOT NULL,
    source text NOT NULL,
    source_header jsonb NOT NULL,
    draft_revision bigint DEFAULT 1 NOT NULL,
    catalog_revision bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    changed_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + '24:00:00'::interval) NOT NULL,
    saved_at timestamp with time zone,
    save_key uuid,
    save_result jsonb,
    CONSTRAINT collection_import_draft_revision_check CHECK ((draft_revision > 0)),
    CONSTRAINT collection_import_saved_fields CHECK (((status = 'saved'::text) = ((saved_at IS NOT NULL) AND (save_key IS NOT NULL) AND (save_result IS NOT NULL)))),
    CONSTRAINT collection_import_status_check CHECK ((status = ANY (ARRAY['open'::text, 'saved'::text])))
);

-- TABLE: collection_import_row

CREATE TABLE collection_import_row (
    import_id uuid NOT NULL,
    row_number integer NOT NULL,
    group_name text,
    raw_text text NOT NULL,
    parsed jsonb NOT NULL,
    quantity bigint,
    status text NOT NULL,
    printing_id uuid,
    edition_id uuid,
    candidates jsonb DEFAULT '[]'::jsonb NOT NULL,
    left_out_reason text,
    skipped boolean DEFAULT false NOT NULL,
    fix jsonb,
    CONSTRAINT collection_import_row_quantity_check CHECK ((quantity > 0)),
    CONSTRAINT collection_import_row_ready_has_edition CHECK (((status <> ALL (ARRAY['matched'::text, 'finish_unknown'::text, 'by_name'::text])) OR ((printing_id IS NOT NULL) AND (edition_id IS NOT NULL) AND (quantity IS NOT NULL)))),
    CONSTRAINT collection_import_row_row_number_check CHECK ((row_number > 0)),
    CONSTRAINT collection_import_row_status_check CHECK ((status = ANY (ARRAY['matched'::text, 'finish_unknown'::text, 'by_name'::text, 'ambiguous'::text, 'not_found'::text, 'unreadable'::text])))
);

-- TABLE: collection_import_start

CREATE TABLE collection_import_start (
    id uuid NOT NULL,
    owner_id text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL
);

-- TABLE: collector_profile

CREATE TABLE collector_profile (
    user_id text NOT NULL,
    handle text NOT NULL,
    handle_key text NOT NULL,
    display_name text NOT NULL,
    handle_changed_at timestamp with time zone,
    open_to_cash_offers boolean DEFAULT false NOT NULL,
    trader_id uuid DEFAULT gen_random_uuid() NOT NULL,
    suspended_at timestamp with time zone,
    CONSTRAINT collector_profile_check CHECK ((handle_key = lower(handle))),
    CONSTRAINT collector_profile_display_name_check CHECK (((char_length(display_name) >= 1) AND (char_length(display_name) <= 40))),
    CONSTRAINT collector_profile_handle_check CHECK ((handle ~ '^[A-Za-z0-9_]{3,20}$'::text))
);

-- TABLE: conversation

CREATE TABLE conversation (
    id uuid NOT NULL,
    user_low text,
    user_high text,
    low_name text NOT NULL,
    high_name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_activity_at timestamp with time zone DEFAULT now() NOT NULL,
    changed_at timestamp with time zone DEFAULT now() NOT NULL,
    last_from_low_at timestamp with time zone,
    last_from_high_at timestamp with time zone,
    CONSTRAINT conversation_high_name_check CHECK (((char_length(high_name) >= 1) AND (char_length(high_name) <= 40))),
    CONSTRAINT conversation_low_name_check CHECK (((char_length(low_name) >= 1) AND (char_length(low_name) <= 40))),
    CONSTRAINT conversation_ordered CHECK (((user_low IS NULL) OR (user_high IS NULL) OR ((user_low COLLATE "C") < (user_high COLLATE "C"))))
);

-- TABLE: conversation_member

CREATE TABLE conversation_member (
    conversation_id uuid NOT NULL,
    member_id text NOT NULL,
    read_at timestamp with time zone,
    archived_at timestamp with time zone
);

-- TABLE: deck_cover

CREATE TABLE deck_cover (
    owner_id text NOT NULL,
    deck_id uuid NOT NULL,
    edition_id uuid NOT NULL
);

-- TABLE: deck_list

CREATE TABLE deck_list (
    owner_id text NOT NULL,
    deck_id uuid NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    target_format text DEFAULT 'standard'::text NOT NULL,
    CONSTRAINT deck_list_revision_check CHECK ((revision > 0)),
    CONSTRAINT deck_list_target_format_check CHECK ((target_format = ANY (ARRAY['standard'::text, 'expanded'::text, 'glc'::text])))
);

-- TABLE: deck_list_line

CREATE TABLE deck_list_line (
    owner_id text NOT NULL,
    deck_id uuid NOT NULL,
    edition_id uuid NOT NULL,
    quantity bigint NOT NULL,
    CONSTRAINT deck_list_line_quantity_check CHECK ((quantity > 0))
);

-- TABLE: deck_publication

CREATE TABLE deck_publication (
    token text NOT NULL,
    owner_id text NOT NULL,
    deck_id uuid,
    version bigint DEFAULT 1 NOT NULL,
    title text NOT NULL,
    revoked boolean DEFAULT false NOT NULL,
    visibility text DEFAULT 'unlisted'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT deck_publication_visibility_check CHECK ((visibility = ANY (ARRAY['unlisted'::text, 'listed'::text])))
);

-- TABLE: discovery_setting

CREATE TABLE discovery_setting (
    user_id text NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    zip character(5),
    lat double precision,
    lon double precision,
    radius_mi smallint DEFAULT 25 NOT NULL,
    removed_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT discovery_setting_enabled_has_place CHECK (((NOT enabled) OR ((zip IS NOT NULL) AND (lat IS NOT NULL) AND (lon IS NOT NULL)))),
    CONSTRAINT discovery_setting_enabled_not_removed CHECK ((NOT (enabled AND (removed_at IS NOT NULL)))),
    CONSTRAINT discovery_setting_radius_mi_check CHECK ((radius_mi = ANY (ARRAY[5, 10, 25, 50])))
);

-- TABLE: friend_request_declined

CREATE TABLE friend_request_declined (
    sender_id text NOT NULL,
    recipient_id text NOT NULL,
    declined_at timestamp with time zone DEFAULT now() NOT NULL
);

-- TABLE: friendship

CREATE TABLE friendship (
    user_low text NOT NULL,
    user_high text NOT NULL,
    state text NOT NULL,
    requested_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    via_trade boolean DEFAULT false NOT NULL,
    CONSTRAINT friendship_pair_order CHECK (((user_low COLLATE "C") < (user_high COLLATE "C"))),
    CONSTRAINT friendship_requested_by_member CHECK (((requested_by = user_low) OR (requested_by = user_high))),
    CONSTRAINT friendship_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'accepted'::text])))
);

-- TABLE: handle_lookup_event

CREATE TABLE handle_lookup_event (
    user_id text NOT NULL,
    kind text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT handle_lookup_event_kind_check CHECK ((kind = ANY (ARRAY['lookup'::text, 'handle_change'::text, 'friend_command'::text, 'loan_command'::text, 'trade_command'::text, 'zip_change'::text, 'new_conversation'::text, 'message'::text])))
);

-- TABLE: holding

CREATE TABLE holding (
    owner_id text NOT NULL,
    location_id uuid NOT NULL,
    edition_id uuid NOT NULL,
    quantity bigint NOT NULL,
    version bigint NOT NULL,
    CONSTRAINT holding_quantity_check CHECK ((quantity > 0)),
    CONSTRAINT holding_version_check CHECK ((version > 0))
);

-- TABLE: inbox_update

CREATE TABLE inbox_update (
    id uuid NOT NULL,
    recipient_id text NOT NULL,
    kind text NOT NULL,
    loan_id uuid,
    other_name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    read_at timestamp with time zone,
    dismissed_at timestamp with time zone,
    trade_id uuid,
    CONSTRAINT inbox_update_kind_check CHECK ((kind = ANY (ARRAY['accepted'::text, 'partly_accepted'::text, 'declined'::text, 'cancelled'::text, 'return_by_changed'::text, 'swapped'::text]))),
    CONSTRAINT inbox_update_one_subject CHECK ((num_nonnulls(loan_id, trade_id) = 1)),
    CONSTRAINT inbox_update_other_name_check CHECK (((char_length(other_name) >= 1) AND (char_length(other_name) <= 40)))
);

-- TABLE: inventory_owner

CREATE TABLE inventory_owner (
    user_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    want_list_counting text DEFAULT 'all_at_once'::text NOT NULL,
    settings_revision bigint DEFAULT 1 NOT NULL,
    CONSTRAINT inventory_owner_want_list_counting_check CHECK ((want_list_counting = ANY (ARRAY['all_at_once'::text, 'one_at_a_time'::text])))
);

-- TABLE: inventory_undo

CREATE TABLE inventory_undo (
    id uuid NOT NULL,
    owner_id text NOT NULL,
    action text NOT NULL,
    source_id uuid,
    destination_id uuid,
    created_at timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
    expires_at timestamp with time zone DEFAULT (statement_timestamp() + '00:10:00'::interval) NOT NULL,
    payload jsonb NOT NULL,
    source_count integer DEFAULT 1 NOT NULL,
    returns_as_surplus boolean DEFAULT false NOT NULL,
    CONSTRAINT inventory_undo_action_check CHECK ((action = ANY (ARRAY['move'::text, 'remove'::text, 'add'::text]))),
    CONSTRAINT inventory_undo_source_count_check CHECK ((source_count >= 0)),
    CONSTRAINT inventory_undo_source_present CHECK (
CASE
    WHEN (action = 'add'::text) THEN ((source_id IS NULL) AND (source_count = 0) AND (destination_id IS NOT NULL))
    ELSE ((source_count > 0) AND ((source_id IS NOT NULL) OR (source_count > 1)))
END)
);

-- TABLE: invite_link

CREATE TABLE invite_link (
    user_id text NOT NULL,
    token text NOT NULL,
    token_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT invite_link_token_check CHECK ((token ~ '^[A-Za-z0-9_-]{32}$'::text)),
    CONSTRAINT invite_link_token_hash_check CHECK ((token_hash ~ '^[0-9a-f]{64}$'::text))
);

-- TABLE: invite_projection_outbox

CREATE TABLE invite_projection_outbox (
    id bigint NOT NULL,
    token_hash text NOT NULL,
    display_name text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT invite_projection_outbox_display_name_check CHECK (((display_name IS NULL) OR ((char_length(display_name) >= 1) AND (char_length(display_name) <= 40)))),
    CONSTRAINT invite_projection_outbox_token_hash_check CHECK ((token_hash ~ '^[0-9a-f]{64}$'::text))
);

-- SEQUENCE: invite_projection_outbox_id_seq

CREATE SEQUENCE invite_projection_outbox_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

-- TABLE: legacy_contact

CREATE TABLE legacy_contact (
    user_low text NOT NULL,
    user_high text NOT NULL,
    CONSTRAINT legacy_contact_check CHECK (((user_low COLLATE "C") < (user_high COLLATE "C")))
);

-- TABLE: loan

CREATE TABLE loan (
    id uuid NOT NULL,
    kind text NOT NULL,
    state text NOT NULL,
    closed_reason text,
    lender_id text,
    borrower_id text,
    lender_name text NOT NULL,
    borrower_name text NOT NULL,
    deck_id uuid,
    return_by date,
    lender_handover_at timestamp with time zone,
    borrower_handover_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    accepted_at timestamp with time zone,
    closed_at timestamp with time zone,
    closed_by text,
    revision bigint DEFAULT 1 NOT NULL,
    extension_to date,
    written_off_at timestamp with time zone,
    extension_asked_at timestamp with time zone,
    thread_id uuid NOT NULL,
    thread_kind text DEFAULT 'loan'::text NOT NULL,
    CONSTRAINT loan_borrower_name_check CHECK (((char_length(borrower_name) >= 1) AND (char_length(borrower_name) <= 40))),
    CONSTRAINT loan_closed_has_reason CHECK (((state = 'closed'::text) = (closed_reason IS NOT NULL))),
    CONSTRAINT loan_closed_reason_check CHECK ((closed_reason = ANY (ARRAY['declined'::text, 'withdrawn'::text, 'cancelled'::text, 'returned'::text, 'written_off'::text]))),
    CONSTRAINT loan_kind_check CHECK ((kind = ANY (ARRAY['borrow_request'::text, 'lend_offer'::text]))),
    CONSTRAINT loan_lender_name_check CHECK (((char_length(lender_name) >= 1) AND (char_length(lender_name) <= 40))),
    CONSTRAINT loan_revision_check CHECK ((revision > 0)),
    CONSTRAINT loan_state_check CHECK ((state = ANY (ARRAY['requested'::text, 'offered'::text, 'accepted'::text, 'handed_over'::text, 'closed'::text]))),
    CONSTRAINT loan_thread_kind_check CHECK ((thread_kind = 'loan'::text)),
    CONSTRAINT loan_two_collectors CHECK ((lender_id <> borrower_id))
);

-- TABLE: loan_line

CREATE TABLE loan_line (
    loan_id uuid NOT NULL,
    edition_id uuid NOT NULL,
    "position" integer NOT NULL,
    requested bigint NOT NULL,
    promised bigint DEFAULT 0 NOT NULL,
    written_off bigint DEFAULT 0 NOT NULL,
    CONSTRAINT loan_line_check CHECK (((written_off >= 0) AND (written_off <= promised))),
    CONSTRAINT loan_line_position_check CHECK (("position" >= 0)),
    CONSTRAINT loan_line_promised_check CHECK ((promised >= 0)),
    CONSTRAINT loan_line_requested_check CHECK ((requested >= 0))
);

-- TABLE: loan_notice_seen

CREATE TABLE loan_notice_seen (
    loan_id uuid NOT NULL,
    user_id text NOT NULL,
    kind text NOT NULL,
    seen_at timestamp with time zone DEFAULT now() NOT NULL,
    dismissed_at timestamp with time zone,
    CONSTRAINT loan_notice_seen_kind CHECK ((kind = ANY (ARRAY['overdue'::text, 'nudge_answer'::text, 'nudge_handover'::text, 'nudge'::text])))
);

-- TABLE: loan_pick

CREATE TABLE loan_pick (
    id bigint NOT NULL,
    loan_id uuid NOT NULL,
    owner_id text NOT NULL,
    edition_id uuid NOT NULL,
    source_location_id uuid,
    quantity bigint NOT NULL,
    state text DEFAULT 'reserved'::text NOT NULL,
    CONSTRAINT loan_pick_quantity_check CHECK ((quantity > 0)),
    CONSTRAINT loan_pick_state_check CHECK ((state = ANY (ARRAY['reserved'::text, 'lent'::text])))
);

-- SEQUENCE: loan_pick_id_seq

CREATE SEQUENCE loan_pick_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

-- TABLE: loan_return

CREATE TABLE loan_return (
    id uuid NOT NULL,
    loan_id uuid NOT NULL,
    started_by text NOT NULL,
    lender_confirmed_at timestamp with time zone,
    borrower_confirmed_at timestamp with time zone,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT loan_return_started_by_check CHECK ((started_by = ANY (ARRAY['lender'::text, 'borrower'::text]))),
    CONSTRAINT loan_return_starter_confirmed CHECK ((((started_by = 'lender'::text) AND (lender_confirmed_at IS NOT NULL)) OR ((started_by = 'borrower'::text) AND (borrower_confirmed_at IS NOT NULL))))
);

-- TABLE: loan_return_line

CREATE TABLE loan_return_line (
    return_id uuid NOT NULL,
    loan_id uuid NOT NULL,
    edition_id uuid NOT NULL,
    quantity bigint NOT NULL,
    CONSTRAINT loan_return_line_quantity_check CHECK ((quantity > 0))
);

-- TABLE: location

CREATE TABLE location (
    id uuid NOT NULL,
    owner_id text NOT NULL,
    parent_id uuid,
    name text NOT NULL,
    kind text NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    hidden boolean DEFAULT false NOT NULL,
    for_trade boolean DEFAULT false NOT NULL,
    CONSTRAINT location_deck_not_for_trade CHECK (((NOT for_trade) OR (kind <> 'deck'::text))),
    CONSTRAINT location_kind_check CHECK ((kind = ANY (ARRAY['storage_leaf'::text, 'organization'::text, 'deck'::text])))
);

-- TABLE: location_command

CREATE TABLE location_command (
    owner_id text NOT NULL,
    request_key uuid NOT NULL,
    request_digest text NOT NULL,
    response jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

-- TABLE: message

CREATE TABLE message (
    id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    from_low boolean NOT NULL,
    client_key uuid NOT NULL,
    body text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT message_body_check CHECK (((char_length(body) >= 1) AND (char_length(body) <= 1000)))
);

-- TABLE: missing_card_report

CREATE TABLE missing_card_report (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    reporter_id text,
    kind text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    set_id text,
    set_name text,
    collector_number text,
    english_name text,
    printing_id uuid,
    descriptor jsonb,
    evidence_url text,
    note text DEFAULT ''::text NOT NULL,
    review_reason text,
    reviewer_id text,
    reviewed_at timestamp with time zone,
    approved_printing_id uuid,
    approved_edition_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT missing_card_report_check CHECK ((((kind = 'printing'::text) AND (printing_id IS NULL)) OR (kind = 'edition'::text))),
    CONSTRAINT missing_card_report_kind_check CHECK ((kind = ANY (ARRAY['printing'::text, 'edition'::text]))),
    CONSTRAINT missing_card_report_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'needs_info'::text, 'rejected'::text, 'approved'::text])))
);

-- TABLE: moderation_event

CREATE TABLE moderation_event (
    id uuid NOT NULL,
    subject_id text,
    subject_name text NOT NULL,
    report_id uuid,
    action text NOT NULL,
    owner_id text NOT NULL,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT moderation_event_action_check CHECK ((action = ANY (ARRAY['dismiss'::text, 'remove_from_discovery'::text, 'suspend'::text, 'restore_discovery'::text, 'lift_suspension'::text]))),
    CONSTRAINT moderation_event_note_check CHECK (((note IS NULL) OR ((char_length(note) >= 1) AND (char_length(note) <= 1000))))
);

-- TABLE: move_manifest

CREATE TABLE move_manifest (
    owner_id text NOT NULL,
    id uuid NOT NULL,
    source_id uuid,
    expires_at timestamp with time zone DEFAULT (now() + '01:00:00'::interval) NOT NULL
);

-- TABLE: move_manifest_entry

CREATE TABLE move_manifest_entry (
    owner_id text NOT NULL,
    source_id uuid NOT NULL,
    edition_id uuid NOT NULL,
    quantity bigint NOT NULL,
    expected_version bigint NOT NULL,
    CONSTRAINT move_manifest_entry_expected_version_check CHECK ((expected_version > 0)),
    CONSTRAINT move_manifest_entry_quantity_check CHECK ((quantity > 0))
);

-- TABLE: move_manifest_item

CREATE TABLE move_manifest_item (
    owner_id text NOT NULL,
    edition_id uuid NOT NULL,
    quantity bigint NOT NULL,
    expected_version bigint NOT NULL,
    CONSTRAINT move_manifest_item_expected_version_check CHECK ((expected_version > 0)),
    CONSTRAINT move_manifest_item_quantity_check CHECK ((quantity > 0))
);

-- TABLE: move_response

CREATE TABLE move_response (
    owner_id text NOT NULL,
    request_key uuid NOT NULL,
    edition_count integer NOT NULL,
    copy_count numeric(30,0) NOT NULL,
    source_count integer DEFAULT 1 NOT NULL,
    already_at_destination_count numeric(30,0) DEFAULT 0 NOT NULL,
    CONSTRAINT move_response_already_at_destination_count_check CHECK ((already_at_destination_count >= (0)::numeric)),
    CONSTRAINT move_response_copy_count_check CHECK ((copy_count > (0)::numeric)),
    CONSTRAINT move_response_edition_count_check CHECK ((edition_count > 0)),
    CONSTRAINT move_response_source_count_check CHECK ((source_count >= 0))
);

-- TABLE: mutation_request

CREATE TABLE mutation_request (
    owner_id text NOT NULL,
    request_key uuid NOT NULL,
    command_digest text NOT NULL,
    result_revision bigint NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + '24:00:00'::interval) NOT NULL
);

-- TABLE: mutation_response

CREATE TABLE mutation_response (
    owner_id text NOT NULL,
    request_key uuid NOT NULL,
    result_quantity bigint NOT NULL,
    result_version bigint NOT NULL,
    CONSTRAINT mutation_response_result_quantity_check CHECK ((result_quantity > 0)),
    CONSTRAINT mutation_response_result_version_check CHECK ((result_version > 0))
);

-- TABLE: operations_alert

CREATE TABLE operations_alert (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    kind text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    delivered_at timestamp with time zone,
    CONSTRAINT operations_alert_kind_check CHECK ((kind = 'backup_stale'::text))
);

-- TABLE: operations_counter

CREATE TABLE operations_counter (
    name text NOT NULL,
    count bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT operations_counter_count_check CHECK ((count >= 0)),
    CONSTRAINT operations_counter_name_check CHECK ((name = ANY (ARRAY['sign_in_delivered'::text, 'sign_in_failed'::text, 'authorization_denials'::text, 'release_failed'::text, 'quota_warnings'::text, 'too_many_sign_ups'::text])))
);

-- TABLE: operations_hour

CREATE TABLE operations_hour (
    hour timestamp with time zone NOT NULL,
    requests bigint DEFAULT 0 NOT NULL,
    failures bigint DEFAULT 0 NOT NULL,
    authorization_denials bigint DEFAULT 0 NOT NULL,
    elapsed_ms bigint DEFAULT 0 NOT NULL
);

-- TABLE: operations_quota

CREATE TABLE operations_quota (
    resource text NOT NULL,
    used bigint NOT NULL,
    allowance bigint NOT NULL,
    measured_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT operations_quota_allowance_check CHECK ((allowance > 0)),
    CONSTRAINT operations_quota_resource_check CHECK ((resource = ANY (ARRAY['database_bytes'::text, 'storage_bytes'::text, 'email_monthly'::text, 'requests_monthly'::text, 'runtime_ms'::text]))),
    CONSTRAINT operations_quota_used_check CHECK ((used >= 0))
);

-- TABLE: operations_state

CREATE TABLE operations_state (
    singleton boolean DEFAULT true NOT NULL,
    backup_last_success timestamp with time zone,
    restore_last_success timestamp with time zone,
    backup_failures bigint DEFAULT 0 NOT NULL,
    restore_failures bigint DEFAULT 0 NOT NULL,
    backup_stale boolean DEFAULT false NOT NULL,
    backup_alerts bigint DEFAULT 0 NOT NULL,
    watchdog_last_check timestamp with time zone,
    projection_failures bigint DEFAULT 0 NOT NULL,
    CONSTRAINT operations_state_singleton_check CHECK (singleton)
);

-- TABLE: publication_command

CREATE TABLE publication_command (
    sequence bigint NOT NULL,
    owner_id text NOT NULL,
    request_key uuid NOT NULL,
    request_digest text NOT NULL,
    token text NOT NULL,
    projection jsonb,
    result jsonb NOT NULL,
    projected boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

-- SEQUENCE: publication_command_sequence_seq

CREATE SEQUENCE publication_command_sequence_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

-- TABLE: released_handle

CREATE TABLE released_handle (
    handle_key text NOT NULL,
    released_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT released_handle_handle_key_check CHECK ((handle_key ~ '^[a-z0-9_]{3,20}$'::text))
);

-- TABLE: thread

CREATE TABLE thread (
    id uuid NOT NULL,
    kind text NOT NULL,
    user_low text,
    user_high text,
    created_at timestamp with time zone NOT NULL,
    last_activity_at timestamp with time zone NOT NULL,
    changed_at timestamp with time zone NOT NULL,
    last_from_low_at timestamp with time zone,
    last_from_high_at timestamp with time zone,
    CONSTRAINT thread_check CHECK (((user_low IS NULL) OR (user_high IS NULL) OR ((user_low COLLATE "C") < (user_high COLLATE "C")))),
    CONSTRAINT thread_kind_check CHECK ((kind = ANY (ARRAY['trade'::text, 'loan'::text])))
);

-- TABLE: thread_event

CREATE TABLE thread_event (
    id uuid NOT NULL,
    thread_id uuid NOT NULL,
    actor text,
    kind text NOT NULL,
    round_id uuid NOT NULL,
    return_id uuid,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL,
    source_key text,
    CONSTRAINT thread_event_actor_check CHECK ((actor = ANY (ARRAY['low'::text, 'high'::text])))
);

-- TABLE: thread_member

CREATE TABLE thread_member (
    thread_id uuid NOT NULL,
    member_id text NOT NULL,
    read_at timestamp with time zone
);

-- TABLE: thread_message

CREATE TABLE thread_message (
    id uuid NOT NULL,
    thread_id uuid NOT NULL,
    from_low boolean NOT NULL,
    client_key uuid NOT NULL,
    body text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT thread_message_body_check CHECK (((char_length(body) >= 1) AND (char_length(body) <= 1000)))
);

-- TABLE: thread_round_source

CREATE TABLE thread_round_source (
    kind text NOT NULL,
    round_id uuid NOT NULL,
    thread_id uuid NOT NULL
);

-- TABLE: trade

CREATE TABLE trade (
    id uuid NOT NULL,
    state text NOT NULL,
    closed_reason text,
    proposer_id text,
    recipient_id text,
    proposer_name text NOT NULL,
    recipient_name text NOT NULL,
    countered_from uuid,
    cash_cents bigint DEFAULT 0 NOT NULL,
    cash_payer text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    accepted_at timestamp with time zone,
    proposer_swap_at timestamp with time zone,
    recipient_swap_at timestamp with time zone,
    closed_at timestamp with time zone,
    closed_by text,
    revision bigint DEFAULT 1 NOT NULL,
    conversation_id uuid,
    thread_id uuid NOT NULL,
    thread_kind text DEFAULT 'trade'::text NOT NULL,
    CONSTRAINT trade_cash_cents_check CHECK (((cash_cents >= 0) AND (cash_cents <= 99999999))),
    CONSTRAINT trade_cash_has_payer CHECK (((cash_cents = 0) = (cash_payer IS NULL))),
    CONSTRAINT trade_cash_payer_check CHECK ((cash_payer = ANY (ARRAY['proposer'::text, 'recipient'::text]))),
    CONSTRAINT trade_closed_has_reason CHECK (((state = 'closed'::text) = (closed_reason IS NOT NULL))),
    CONSTRAINT trade_closed_reason_check CHECK ((closed_reason = ANY (ARRAY['declined'::text, 'withdrawn'::text, 'countered'::text, 'cancelled'::text, 'swapped'::text]))),
    CONSTRAINT trade_proposer_name_check CHECK (((char_length(proposer_name) >= 1) AND (char_length(proposer_name) <= 40))),
    CONSTRAINT trade_recipient_name_check CHECK (((char_length(recipient_name) >= 1) AND (char_length(recipient_name) <= 40))),
    CONSTRAINT trade_revision_check CHECK ((revision > 0)),
    CONSTRAINT trade_state_check CHECK ((state = ANY (ARRAY['proposed'::text, 'accepted'::text, 'closed'::text]))),
    CONSTRAINT trade_swap_after_accept CHECK (((state <> 'proposed'::text) OR ((proposer_swap_at IS NULL) AND (recipient_swap_at IS NULL)))),
    CONSTRAINT trade_thread_kind_check CHECK ((thread_kind = 'trade'::text)),
    CONSTRAINT trade_two_collectors CHECK ((proposer_id <> recipient_id))
);

-- TABLE: trade_accept

CREATE TABLE trade_accept (
    owner_id text NOT NULL,
    edition_id uuid NOT NULL,
    rule text NOT NULL,
    CONSTRAINT trade_accept_rule_check CHECK ((rule = ANY (ARRAY['printing'::text, 'identity'::text])))
);

-- TABLE: trade_line

CREATE TABLE trade_line (
    trade_id uuid NOT NULL,
    side text NOT NULL,
    edition_id uuid NOT NULL,
    "position" integer NOT NULL,
    quantity bigint NOT NULL,
    CONSTRAINT trade_line_position_check CHECK (("position" >= 0)),
    CONSTRAINT trade_line_quantity_check CHECK ((quantity > 0)),
    CONSTRAINT trade_line_side_check CHECK ((side = ANY (ARRAY['proposer'::text, 'recipient'::text])))
);

-- TABLE: trade_pick

CREATE TABLE trade_pick (
    id bigint DEFAULT nextval('loan_pick_id_seq'::regclass) NOT NULL,
    trade_id uuid NOT NULL,
    side text NOT NULL,
    owner_id text NOT NULL,
    edition_id uuid NOT NULL,
    source_location_id uuid,
    quantity bigint NOT NULL,
    CONSTRAINT trade_pick_quantity_check CHECK ((quantity > 0))
);

-- TABLE: trade_report

CREATE TABLE trade_report (
    id uuid NOT NULL,
    reporter_id text,
    reported_id text,
    reporter_name text NOT NULL,
    reported_name text NOT NULL,
    reporter_handle text NOT NULL,
    reported_handle text NOT NULL,
    reason text NOT NULL,
    note text,
    source text NOT NULL,
    trade_id uuid,
    conversation_id uuid,
    status text DEFAULT 'open'::text NOT NULL,
    decision text,
    decided_at timestamp with time zone,
    decided_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT trade_report_decided CHECK ((((status = 'open'::text) = (decision IS NULL)) AND ((status = 'open'::text) = (decided_at IS NULL)) AND ((status <> 'dismissed'::text) OR (decision = 'dismiss'::text)) AND ((status <> 'actioned'::text) OR (decision = ANY (ARRAY['remove_from_discovery'::text, 'suspend'::text]))))),
    CONSTRAINT trade_report_decision_check CHECK ((decision = ANY (ARRAY['dismiss'::text, 'remove_from_discovery'::text, 'suspend'::text]))),
    CONSTRAINT trade_report_note_check CHECK (((note IS NULL) OR ((char_length(note) >= 1) AND (char_length(note) <= 1000)))),
    CONSTRAINT trade_report_reason_check CHECK ((reason = ANY (ARRAY['scam_or_no_show'::text, 'harassment'::text, 'inappropriate_content'::text, 'other'::text]))),
    CONSTRAINT trade_report_source_check CHECK ((source = ANY (ARRAY['conversation'::text, 'discovery'::text, 'trade'::text]))),
    CONSTRAINT trade_report_status_check CHECK ((status = ANY (ARRAY['open'::text, 'dismissed'::text, 'actioned'::text])))
);

-- TABLE: trade_report_message

CREATE TABLE trade_report_message (
    report_id uuid NOT NULL,
    message_id uuid NOT NULL,
    from_reporter boolean NOT NULL,
    body text NOT NULL,
    at timestamp with time zone NOT NULL
);

-- TABLE: trade_report_trade

CREATE TABLE trade_report_trade (
    report_id uuid NOT NULL,
    trade_id uuid NOT NULL,
    facts jsonb NOT NULL
);

-- TABLE: trade_want

CREATE TABLE trade_want (
    owner_id text NOT NULL,
    edition_id uuid NOT NULL,
    quantity bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT trade_want_quantity_check CHECK (((quantity >= 1) AND (quantity <= 9999)))
);

-- TABLE: zip_centroid

CREATE TABLE zip_centroid (
    zip character(5) NOT NULL,
    lat double precision NOT NULL,
    lon double precision NOT NULL,
    source text NOT NULL,
    CONSTRAINT zip_centroid_source_check CHECK ((source = ANY (ARRAY['census'::text, 'geonames'::text]))),
    CONSTRAINT zip_centroid_zip_check CHECK ((zip ~ '^[0-9]{5}$'::text))
);

-- SEQUENCE OWNED BY: borrowed_holding_id_seq

ALTER SEQUENCE borrowed_holding_id_seq OWNED BY borrowed_holding.id;

-- SEQUENCE OWNED BY: invite_projection_outbox_id_seq

ALTER SEQUENCE invite_projection_outbox_id_seq OWNED BY invite_projection_outbox.id;

-- SEQUENCE OWNED BY: loan_pick_id_seq

ALTER SEQUENCE loan_pick_id_seq OWNED BY loan_pick.id;

-- SEQUENCE OWNED BY: publication_command_sequence_seq

ALTER SEQUENCE publication_command_sequence_seq OWNED BY publication_command.sequence;

-- VIEW: open_discovery

CREATE VIEW open_discovery AS
 SELECT d.user_id,
    p.trader_id,
    d.lat,
    d.lon,
    d.radius_mi
   FROM (discovery_setting d
     JOIN collector_profile p ON ((p.user_id = d.user_id)))
  WHERE (d.enabled AND (d.removed_at IS NULL) AND (p.suspended_at IS NULL));

-- FUNCTION: borrowed_holding_leaf_guard()

CREATE FUNCTION borrowed_holding_leaf_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM location l
    WHERE l.owner_id = NEW.borrower_id AND l.id = NEW.location_id
      AND l.kind IN ('storage_leaf', 'deck')
      AND NOT EXISTS (SELECT 1 FROM location child WHERE child.parent_id = l.id)
  ) THEN
    RAISE EXCEPTION 'A Borrowed Copy requires one of the borrower''s Storage Leaves' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- FUNCTION: trade_reserved_copies(text[], uuid[])

CREATE FUNCTION trade_reserved_copies(owners text[], editions uuid[]) RETURNS TABLE(owner_id text, edition_id uuid, reserved bigint)
    LANGUAGE sql STABLE
    AS $$
  SELECT x.owner_id, x.edition_id, sum(x.quantity)::bigint FROM (
    SELECT t.proposer_id AS owner_id, l.edition_id, l.quantity FROM trade t JOIN trade_line l ON l.trade_id = t.id
      WHERE l.side = 'proposer' AND t.proposer_id = ANY(owners)
        AND t.state IN ('proposed', 'accepted') AND t.proposer_swap_at IS NULL
    UNION ALL
    SELECT t.recipient_id, l.edition_id, l.quantity FROM trade t JOIN trade_line l ON l.trade_id = t.id
      WHERE l.side = 'recipient' AND t.recipient_id = ANY(owners)
        AND t.state = 'accepted' AND t.recipient_swap_at IS NULL
  ) x WHERE editions IS NULL OR x.edition_id = ANY(editions)
  GROUP BY x.owner_id, x.edition_id
$$;

-- FUNCTION: reserved_copies(text[], uuid[])

CREATE FUNCTION reserved_copies(owners text[], editions uuid[]) RETURNS TABLE(owner_id text, edition_id uuid, reserved bigint)
    LANGUAGE sql STABLE
    AS $$
  SELECT x.owner_id, x.edition_id, sum(x.reserved)::bigint FROM (
    SELECT o.lender_id AS owner_id, l.edition_id, sum(l.promised)::bigint AS reserved
    FROM loan o JOIN loan_line l ON l.loan_id = o.id
    WHERE o.lender_id = ANY(owners) AND o.state IN ('offered', 'accepted') AND o.lender_handover_at IS NULL
      AND l.promised > 0 AND (editions IS NULL OR l.edition_id = ANY(editions))
    GROUP BY o.lender_id, l.edition_id
    UNION ALL
    SELECT t.owner_id, t.edition_id, t.reserved FROM trade_reserved_copies(owners, editions) t
  ) x
  GROUP BY x.owner_id, x.edition_id
$$;

-- FUNCTION: check_loan_promises(text, uuid)

CREATE FUNCTION check_loan_promises(owner text, edition uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
  promised bigint;
  held bigint;
BEGIN
  IF owner IS NULL OR edition IS NULL THEN
    RETURN;
  END IF;
  SELECT coalesce(sum(r.reserved), 0) INTO promised FROM reserved_copies(ARRAY[owner], ARRAY[edition]) r;
  IF promised = 0 THEN
    RETURN;
  END IF;
  SELECT coalesce(sum(h.quantity), 0) INTO held FROM holding h WHERE h.owner_id = owner AND h.edition_id = edition;
  IF promised > held THEN
    RAISE EXCEPTION 'Open Loans and Trades promise % copies of a Card Edition its owner holds % of', promised, held
      USING ERRCODE = '23514', CONSTRAINT = 'loan_promises_owned';
  END IF;
END $$;

-- FUNCTION: cleanup_inventory_undo()

CREATE FUNCTION cleanup_inventory_undo() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 DELETE FROM inventory_undo WHERE owner_id=NEW.user_id AND expires_at<=clock_timestamp();
 RETURN NEW;
END $$;

-- FUNCTION: conversation_archived()

CREATE FUNCTION conversation_archived() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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

-- FUNCTION: generated_handle()

CREATE FUNCTION generated_handle() RETURNS text
    LANGUAGE plpgsql
    AS $$
DECLARE
  alphabet constant text := 'bcdfghjklmnpqrstvwxz2689';
  noise bytea := sha256(uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid()));
  result text := 'collector_';
BEGIN
  FOR i IN 0..7 LOOP
    result := result || substr(alphabet, get_byte(noise, i) % 24 + 1, 1);
  END LOOP;
  RETURN result;
END $$;

-- FUNCTION: create_collector_profile(text)

CREATE FUNCTION create_collector_profile(owner text) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
  candidate text;
BEGIN
  FOR attempt IN 1..20 LOOP
    IF EXISTS (SELECT 1 FROM collector_profile WHERE user_id = owner) THEN
      RETURN;
    END IF;
    candidate := generated_handle();
    CONTINUE WHEN EXISTS (SELECT 1 FROM released_handle WHERE handle_key = candidate);
    INSERT INTO collector_profile(user_id, handle, handle_key, display_name)
      VALUES (owner, candidate, candidate, 'Collector')
      ON CONFLICT DO NOTHING;
    IF FOUND THEN
      RETURN;
    END IF;
  END LOOP;
  RAISE EXCEPTION 'could not generate a Handle for %', owner;
END $$;

-- FUNCTION: create_deck_list()

CREATE FUNCTION create_deck_list() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  INSERT INTO deck_list(owner_id, deck_id) VALUES (NEW.owner_id, NEW.id) ON CONFLICT DO NOTHING;
  RETURN NULL;
END $$;

-- FUNCTION: deck_list_cover(text[], uuid[], uuid[], bigint[])

CREATE FUNCTION deck_list_cover(owners text[], decks uuid[], editions uuid[], added bigint[]) RETURNS void
    LANGUAGE plpgsql
    AS $_$
BEGIN
  EXECUTE $sql$
  WITH arrived AS (
    SELECT a.owner_id, a.deck_id, a.edition_id, sum(a.added)::bigint AS added
    FROM unnest($1::text[], $2::uuid[], $3::uuid[], $4::bigint[]) AS a(owner_id, deck_id, edition_id, added)
    WHERE a.added > 0
      AND EXISTS (SELECT 1 FROM deck_list d WHERE d.owner_id = a.owner_id AND d.deck_id = a.deck_id)
    GROUP BY a.owner_id, a.deck_id, a.edition_id
  ), held AS (
    SELECT a.owner_id, a.deck_id, a.edition_id, a.added,
      coalesce(h.quantity, 0) + coalesce((SELECT sum(b.quantity) FROM borrowed_holding b
        WHERE b.borrower_id = a.owner_id AND b.location_id = a.deck_id AND b.edition_id = a.edition_id), 0) AS now_held
    FROM arrived a LEFT JOIN holding h
      ON h.owner_id = a.owner_id AND h.location_id = a.deck_id AND h.edition_id = a.edition_id
  ), wanted AS (
    SELECT p.owner_id, p.deck_id, p.edition_id, coalesce(l.quantity, 0) AS listed,
      greatest(coalesce(l.quantity, 0), least(coalesce(l.quantity, 0), p.now_held - p.added) + p.added) AS quantity
    FROM held p LEFT JOIN deck_list_line l
      ON l.owner_id = p.owner_id AND l.deck_id = p.deck_id AND l.edition_id = p.edition_id
  ), covered AS (
    INSERT INTO deck_list_line AS l (owner_id, deck_id, edition_id, quantity)
    SELECT owner_id, deck_id, edition_id, quantity FROM wanted WHERE quantity > listed
    ON CONFLICT (owner_id, deck_id, edition_id) DO UPDATE SET quantity = greatest(l.quantity, EXCLUDED.quantity)
    RETURNING l.owner_id, l.deck_id
  )
  UPDATE deck_list d SET revision = d.revision + 1
  FROM (SELECT DISTINCT owner_id, deck_id FROM covered) c
  WHERE d.owner_id = c.owner_id AND d.deck_id = c.deck_id
  $sql$ USING owners, decks, editions, added;
END $_$;

-- FUNCTION: deck_list_cover_borrowed()

CREATE FUNCTION deck_list_cover_borrowed() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
DECLARE
  owners text[];
  decks uuid[];
  editions uuid[];
  added bigint[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    EXECUTE $sql$
    SELECT array_agg(n.borrower_id), array_agg(n.location_id), array_agg(n.edition_id), array_agg(n.quantity::bigint)
    FROM new_borrowed n
    WHERE EXISTS (SELECT 1 FROM deck_list d WHERE d.owner_id = n.borrower_id AND d.deck_id = n.location_id)
    $sql$ INTO owners, decks, editions, added;
  ELSE
    EXECUTE $sql$
    WITH changed AS (
      SELECT n.borrower_id, n.location_id, n.edition_id, 0::bigint AS before, n.quantity AS after FROM new_borrowed n
      WHERE EXISTS (SELECT 1 FROM deck_list d WHERE d.owner_id = n.borrower_id AND d.deck_id = n.location_id)
      UNION ALL
      SELECT o.borrower_id, o.location_id, o.edition_id, o.quantity, 0::bigint FROM old_borrowed o
      WHERE EXISTS (SELECT 1 FROM deck_list d WHERE d.owner_id = o.borrower_id AND d.deck_id = o.location_id)
    ), arrived AS (
      SELECT borrower_id, location_id, edition_id, (sum(after) - sum(before))::bigint AS added
      FROM changed GROUP BY borrower_id, location_id, edition_id
      HAVING sum(after) > sum(before)
    )
    SELECT array_agg(borrower_id), array_agg(location_id), array_agg(edition_id), array_agg(added) FROM arrived
    $sql$ INTO owners, decks, editions, added;
  END IF;
  IF owners IS NOT NULL THEN
    PERFORM deck_list_cover(owners, decks, editions, added);
  END IF;
  RETURN NULL;
END $_$;

-- FUNCTION: deck_list_cover_holdings()

CREATE FUNCTION deck_list_cover_holdings() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
DECLARE
  owners text[];
  decks uuid[];
  editions uuid[];
  added bigint[];
BEGIN
  -- Set (transaction-local) only around the statement that returns copies to a Deck as surplus.
  IF current_setting('tcg.undo_returns_surplus', true) = 'on' THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'INSERT' THEN
    EXECUTE $sql$
    SELECT array_agg(n.owner_id), array_agg(n.location_id), array_agg(n.edition_id), array_agg(n.quantity::bigint)
    FROM new_holding n
    WHERE EXISTS (SELECT 1 FROM deck_list d WHERE d.owner_id = n.owner_id AND d.deck_id = n.location_id)
    $sql$ INTO owners, decks, editions, added;
  ELSE
    -- Old and new rows are paired by key, as in 047: a Holding with no old row under the same key arrived whole.
    EXECUTE $sql$
    WITH changed AS (
      SELECT n.owner_id, n.location_id, n.edition_id, 0::bigint AS before, n.quantity AS after FROM new_holding n
      WHERE EXISTS (SELECT 1 FROM deck_list d WHERE d.owner_id = n.owner_id AND d.deck_id = n.location_id)
      UNION ALL
      SELECT o.owner_id, o.location_id, o.edition_id, o.quantity, 0::bigint FROM old_holding o
      WHERE EXISTS (SELECT 1 FROM deck_list d WHERE d.owner_id = o.owner_id AND d.deck_id = o.location_id)
    ), arrived AS (
      SELECT owner_id, location_id, edition_id, (sum(after) - sum(before))::bigint AS added
      FROM changed GROUP BY owner_id, location_id, edition_id
      HAVING sum(after) > sum(before)
    )
    SELECT array_agg(owner_id), array_agg(location_id), array_agg(edition_id), array_agg(added) FROM arrived
    $sql$ INTO owners, decks, editions, added;
  END IF;
  IF owners IS NOT NULL THEN
    PERFORM deck_list_cover(owners, decks, editions, added);
  END IF;
  RETURN NULL;
END $_$;

-- FUNCTION: distance_band(double precision, double precision, double precision, double precision)

CREATE FUNCTION distance_band(lat1 double precision, lon1 double precision, lat2 double precision, lon2 double precision) RETURNS smallint
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$
  SELECT (CASE WHEN m < 5 THEN 1 WHEN m < 10 THEN 2 WHEN m < 25 THEN 3 WHEN m <= 50 THEN 4 END)::smallint
  FROM (SELECT round((2 * 3958.8 * asin(least(1, sqrt(
          sin(radians(lat2 - lat1) / 2) ^ 2
          + cos(radians(lat1)) * cos(radians(lat2)) * sin(radians(lon2 - lon1) / 2) ^ 2))))::numeric, 6) AS m
        WHERE lat1 IS NOT NULL AND lon1 IS NOT NULL AND lat2 IS NOT NULL AND lon2 IS NOT NULL) AS d
$$;

-- FUNCTION: for_trade_locations(text[])

CREATE FUNCTION for_trade_locations(owners text[]) RETURNS TABLE(owner_id text, location_id uuid)
    LANGUAGE sql STABLE
    AS $$
  WITH RECURSIVE marked(owner_id, location_id, kind) AS (
    SELECT l.owner_id, l.id, l.kind FROM location l WHERE l.owner_id = ANY(owners) AND l.for_trade
    UNION
    SELECT c.owner_id, c.id, c.kind FROM location c JOIN marked m ON c.owner_id = m.owner_id AND c.parent_id = m.location_id
  )
  SELECT marked.owner_id, marked.location_id FROM marked WHERE marked.kind <> 'deck'
$$;

-- FUNCTION: friends_of(text[])

CREATE FUNCTION friends_of(viewers text[]) RETURNS TABLE(viewer_id text, friend_id text)
    LANGUAGE sql STABLE
    AS $$
  SELECT pair.viewer_id, pair.friend_id FROM (
    SELECT f.user_low AS viewer_id, f.user_high AS friend_id FROM friendship f
      WHERE f.state = 'accepted' AND f.user_low = ANY(viewers)
    UNION ALL
    SELECT f.user_high, f.user_low FROM friendship f WHERE f.state = 'accepted' AND f.user_high = ANY(viewers)
  ) pair
  WHERE NOT EXISTS (SELECT 1 FROM block b WHERE (b.blocker_id = pair.viewer_id AND b.blocked_id = pair.friend_id)
                                             OR (b.blocker_id = pair.friend_id AND b.blocked_id = pair.viewer_id))
$$;

-- FUNCTION: hidden_locations(text[])

CREATE FUNCTION hidden_locations(owners text[]) RETURNS TABLE(owner_id text, location_id uuid)
    LANGUAGE sql STABLE
    AS $$
  WITH RECURSIVE hidden(owner_id, location_id) AS (
    SELECT l.owner_id, l.id FROM location l WHERE l.owner_id = ANY(owners) AND l.hidden
    UNION
    SELECT c.owner_id, c.id FROM location c JOIN hidden h ON c.owner_id = h.owner_id AND c.parent_id = h.location_id
  )
  SELECT hidden.owner_id, hidden.location_id FROM hidden
$$;

-- FUNCTION: holding_leaf_guard()

CREATE FUNCTION holding_leaf_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM location l
    WHERE l.owner_id = NEW.owner_id AND l.id = NEW.location_id
      AND l.kind IN ('storage_leaf', 'deck')
      AND NOT EXISTS (SELECT 1 FROM location child WHERE child.parent_id = l.id)
  ) THEN
    RAISE EXCEPTION 'Holding requires an owned Storage Leaf' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- FUNCTION: holding_promise_guard()

CREATE FUNCTION holding_promise_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM check_loan_promises(OLD.owner_id, OLD.edition_id);
  RETURN NULL;
END $$;

-- FUNCTION: loan_line_promise_guard()

CREATE FUNCTION loan_line_promise_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM check_loan_promises((SELECT o.lender_id FROM loan o WHERE o.id = NEW.loan_id), NEW.edition_id);
  RETURN NULL;
END $$;

-- FUNCTION: loan_names_follow_profile()

CREATE FUNCTION loan_names_follow_profile() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE loan SET lender_name = NEW.display_name WHERE lender_id = NEW.user_id AND lender_name <> NEW.display_name;
  UPDATE loan SET borrower_name = NEW.display_name WHERE borrower_id = NEW.user_id AND borrower_name <> NEW.display_name;
  RETURN NULL;
END $$;

-- FUNCTION: loan_promise_guard()

CREATE FUNCTION loan_promise_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  line record;
BEGIN
  IF NEW.state IN ('offered', 'accepted') AND NEW.lender_handover_at IS NULL THEN
    FOR line IN SELECT l.edition_id FROM loan_line l WHERE l.loan_id = NEW.id AND l.promised > 0 LOOP
      PERFORM check_loan_promises(NEW.lender_id, line.edition_id);
    END LOOP;
  END IF;
  RETURN NULL;
END $$;

-- FUNCTION: mirror_move_manifest_item()

CREATE FUNCTION mirror_move_manifest_item() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  INSERT INTO move_manifest_entry(owner_id,source_id,edition_id,quantity,expected_version)
    SELECT n.owner_id,m.source_id,n.edition_id,n.quantity,n.expected_version
    FROM staged n JOIN move_manifest m ON m.owner_id=n.owner_id
    WHERE m.source_id IS NOT NULL
    ON CONFLICT (owner_id,source_id,edition_id) DO NOTHING;
  RETURN NULL;
END $$;

-- FUNCTION: moderation_event_append_only()

CREATE FUNCTION moderation_event_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN RAISE EXCEPTION 'Moderation events are append-only'; END $$;

-- FUNCTION: nearby_collectors(text, smallint, integer)

CREATE FUNCTION nearby_collectors(viewer text, max_band smallint, max_rows integer) RETURNS TABLE(other_id text, band smallint)
    LANGUAGE sql STABLE
    AS $$
  SELECT d.user_id, distance_band(me.lat, me.lon, d.lat, d.lon)
  FROM open_discovery me
  JOIN open_discovery d
    ON d.lat BETWEEN me.lat - 0.7246 AND me.lat + 0.7246
   AND d.lon BETWEEN me.lon - 50 / (69.172 * cos(radians(least(89, abs(me.lat) + 0.7246))))
                 AND me.lon + 50 / (69.172 * cos(radians(least(89, abs(me.lat) + 0.7246))))
  WHERE me.user_id = viewer AND d.user_id <> viewer
    AND distance_band(me.lat, me.lon, d.lat, d.lon) <= max_band
    AND NOT EXISTS (SELECT 1 FROM friends_of(ARRAY[viewer]) f WHERE f.friend_id = d.user_id)
    AND NOT EXISTS (SELECT 1 FROM block b WHERE (b.blocker_id = viewer AND b.blocked_id = d.user_id)
                                             OR (b.blocker_id = d.user_id AND b.blocked_id = viewer))
  ORDER BY 2, md5(viewer || d.trader_id::text)
  LIMIT max_rows
$$;

-- FUNCTION: onboard_collector_profile()

CREATE FUNCTION onboard_collector_profile() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM create_collector_profile(NEW.user_id);
  RETURN NEW;
END $$;

-- FUNCTION: pair_conversation(text, text, text, text)

CREATE FUNCTION pair_conversation(a text, b text, a_name text, b_name text) RETURNS uuid
    LANGUAGE plpgsql
    AS $$
DECLARE
  a_low boolean := (a COLLATE "C") < (b COLLATE "C");
  pair_id uuid;
BEGIN
  INSERT INTO conversation (id, user_low, user_high, low_name, high_name)
    VALUES (gen_random_uuid(), CASE WHEN a_low THEN a ELSE b END, CASE WHEN a_low THEN b ELSE a END,
            CASE WHEN a_low THEN a_name ELSE b_name END, CASE WHEN a_low THEN b_name ELSE a_name END)
    ON CONFLICT ON CONSTRAINT conversation_pair DO NOTHING;
  SELECT c.id INTO pair_id FROM conversation c
    WHERE c.user_low = CASE WHEN a_low THEN a ELSE b END AND c.user_high = CASE WHEN a_low THEN b ELSE a END;
  INSERT INTO conversation_member (conversation_id, member_id) VALUES (pair_id, a), (pair_id, b)
    ON CONFLICT DO NOTHING;
  RETURN pair_id;
END $$;

-- FUNCTION: queue_invite_record()

CREATE FUNCTION queue_invite_record() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_TABLE_NAME = 'invite_link' THEN
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
      INSERT INTO invite_projection_outbox(token_hash, display_name) VALUES (OLD.token_hash, NULL);
    END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN
      INSERT INTO invite_projection_outbox(token_hash, display_name)
        SELECT NEW.token_hash, p.display_name FROM collector_profile p WHERE p.user_id = NEW.user_id;
    END IF;
  ELSE
    INSERT INTO invite_projection_outbox(token_hash, display_name)
      SELECT l.token_hash, NEW.display_name FROM invite_link l WHERE l.user_id = NEW.user_id;
  END IF;
  RETURN NULL;
END $$;

-- FUNCTION: reserving_picks(text[], uuid[])

CREATE FUNCTION reserving_picks(owners text[], editions uuid[]) RETURNS TABLE(kind text, loan_id uuid, trade_id uuid, pick_id bigint, owner_id text, edition_id uuid, source_location_id uuid, quantity bigint, sort_accepted_at timestamp with time zone, sort_created_at timestamp with time zone)
    LANGUAGE sql STABLE
    AS $$
  SELECT 'loan'::text, p.loan_id, NULL::uuid, p.id, p.owner_id, p.edition_id, p.source_location_id, p.quantity::bigint,
         o.accepted_at, o.created_at
    FROM loan_pick p JOIN loan o ON o.id = p.loan_id
    WHERE p.owner_id = ANY(owners) AND o.lender_id = p.owner_id AND p.state = 'reserved'
      AND o.state IN ('offered', 'accepted') AND o.lender_handover_at IS NULL
      AND (editions IS NULL OR p.edition_id = ANY(editions))
  UNION ALL
  SELECT 'trade'::text, NULL::uuid, p.trade_id, p.id, p.owner_id, p.edition_id, p.source_location_id, p.quantity,
         t.accepted_at, CASE WHEN p.side = 'proposer' THEN t.created_at ELSE t.accepted_at END
    FROM trade_pick p JOIN trade t ON t.id = p.trade_id
    WHERE p.owner_id = ANY(owners) AND (editions IS NULL OR p.edition_id = ANY(editions))
      AND ((p.side = 'proposer' AND t.proposer_id = p.owner_id
            AND t.state IN ('proposed', 'accepted') AND t.proposer_swap_at IS NULL)
        OR (p.side = 'recipient' AND t.recipient_id = p.owner_id
            AND t.state = 'accepted' AND t.recipient_swap_at IS NULL))
$$;

-- FUNCTION: round_in_thread_pair()

CREATE FUNCTION round_in_thread_pair() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
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
END $_$;

-- FUNCTION: thread_immutable()

CREATE FUNCTION thread_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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

-- FUNCTION: trade_conversation_activity()

CREATE FUNCTION trade_conversation_activity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.conversation_id IS NOT NULL THEN
    UPDATE conversation
      SET changed_at = greatest(changed_at + interval '1 microsecond', clock_timestamp()),
          last_activity_at = CASE WHEN TG_OP = 'INSERT' THEN greatest(last_activity_at, clock_timestamp())
                                  ELSE last_activity_at END
      WHERE id = NEW.conversation_id;
  END IF;
  RETURN NULL;
END $$;

-- FUNCTION: trade_joins_conversation()

CREATE FUNCTION trade_joins_conversation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.conversation_id IS NULL AND NEW.proposer_id IS NOT NULL AND NEW.recipient_id IS NOT NULL THEN
    NEW.conversation_id := pair_conversation(NEW.proposer_id, NEW.recipient_id, NEW.proposer_name, NEW.recipient_name);
  END IF;
  RETURN NEW;
END $$;

-- FUNCTION: trade_line_promise_guard()

CREATE FUNCTION trade_line_promise_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  giver text;
BEGIN
  SELECT CASE NEW.side WHEN 'proposer' THEN t.proposer_id ELSE t.recipient_id END INTO giver
  FROM trade t
  WHERE t.id = NEW.trade_id
    AND ((NEW.side = 'proposer' AND t.state IN ('proposed', 'accepted') AND t.proposer_swap_at IS NULL)
      OR (NEW.side = 'recipient' AND t.state = 'accepted' AND t.recipient_swap_at IS NULL));
  PERFORM check_loan_promises(giver, NEW.edition_id);
  RETURN NULL;
END $$;

-- FUNCTION: trade_listable(text[], uuid[])

CREATE FUNCTION trade_listable(owners text[], editions uuid[]) RETURNS TABLE(owner_id text, edition_id uuid, listable bigint)
    LANGUAGE sql STABLE
    AS $$
  WITH ft AS (SELECT DISTINCT f.owner_id, f.location_id FROM for_trade_locations(owners) f),
  picked AS (
    SELECT p.owner_id, p.edition_id, p.source_location_id AS location_id, sum(p.quantity)::bigint AS quantity
    FROM reserving_picks(owners, editions) p WHERE p.source_location_id IS NOT NULL GROUP BY 1, 2, 3),
  per AS (
    SELECT h.owner_id, h.edition_id, sum(h.quantity)::bigint AS total_held,
      coalesce(sum(h.quantity) FILTER (WHERE ft.location_id IS NOT NULL), 0)::bigint AS ft_held,
      coalesce(sum(least(coalesce(pk.quantity, 0), h.quantity)) FILTER (WHERE ft.location_id IS NOT NULL), 0)::bigint
        AS ft_picked
    FROM holding h
    LEFT JOIN ft ON ft.owner_id = h.owner_id AND ft.location_id = h.location_id
    LEFT JOIN picked pk ON pk.owner_id = h.owner_id AND pk.edition_id = h.edition_id AND pk.location_id = h.location_id
    WHERE h.owner_id = ANY(owners) AND (editions IS NULL OR h.edition_id = ANY(editions))
    GROUP BY h.owner_id, h.edition_id),
  listed AS (
    SELECT per.owner_id, per.edition_id,
      greatest(0, least(per.ft_held - per.ft_picked, per.total_held - coalesce(r.reserved, 0)))::bigint AS listable
    FROM per LEFT JOIN reserved_copies(owners, editions) r
      ON r.owner_id = per.owner_id AND r.edition_id = per.edition_id)
  SELECT listed.owner_id, listed.edition_id, listed.listable FROM listed WHERE listed.listable > 0
$$;

-- FUNCTION: trade_names_follow_profile()

CREATE FUNCTION trade_names_follow_profile() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE trade SET proposer_name = NEW.display_name
    WHERE proposer_id = NEW.user_id AND proposer_name <> NEW.display_name;
  UPDATE trade SET recipient_name = NEW.display_name
    WHERE recipient_id = NEW.user_id AND recipient_name <> NEW.display_name;
  RETURN NULL;
END $$;

-- FUNCTION: trade_names_follow_profile_conversations()

CREATE FUNCTION trade_names_follow_profile_conversations() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE conversation SET low_name = NEW.display_name
    WHERE user_low = NEW.user_id AND low_name <> NEW.display_name;
  UPDATE conversation SET high_name = NEW.display_name
    WHERE user_high = NEW.user_id AND high_name <> NEW.display_name;
  RETURN NULL;
END $$;

-- FUNCTION: trade_promise_guard()

CREATE FUNCTION trade_promise_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  line record;
  proposer_rises boolean := false;
  recipient_rises boolean := false;
BEGIN
  IF NEW.state IN ('proposed', 'accepted') AND NEW.proposer_swap_at IS NULL THEN
    IF TG_OP = 'INSERT' THEN
      proposer_rises := true;
    ELSIF NOT (OLD.state IN ('proposed', 'accepted') AND OLD.proposer_swap_at IS NULL)
          OR NEW.proposer_id IS DISTINCT FROM OLD.proposer_id THEN
      proposer_rises := true;
    END IF;
  END IF;
  IF NEW.state = 'accepted' AND NEW.recipient_swap_at IS NULL THEN
    IF TG_OP = 'INSERT' THEN
      recipient_rises := true;
    ELSIF NOT (OLD.state = 'accepted' AND OLD.recipient_swap_at IS NULL)
          OR NEW.recipient_id IS DISTINCT FROM OLD.recipient_id THEN
      recipient_rises := true;
    END IF;
  END IF;
  IF proposer_rises THEN
    FOR line IN SELECT l.edition_id FROM trade_line l WHERE l.trade_id = NEW.id AND l.side = 'proposer' LOOP
      PERFORM check_loan_promises(NEW.proposer_id, line.edition_id);
    END LOOP;
  END IF;
  IF recipient_rises THEN
    FOR line IN SELECT l.edition_id FROM trade_line l WHERE l.trade_id = NEW.id AND l.side = 'recipient' LOOP
      PERFORM check_loan_promises(NEW.recipient_id, line.edition_id);
    END LOOP;
  END IF;
  RETURN NULL;
END $$;

-- FUNCTION: trade_reach(text, text[])

CREATE FUNCTION trade_reach(viewer text, others text[]) RETURNS TABLE(other_id text, how text, band smallint)
    LANGUAGE sql STABLE
    AS $$
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

-- DEFAULT: borrowed_holding id

ALTER TABLE ONLY borrowed_holding ALTER COLUMN id SET DEFAULT nextval('borrowed_holding_id_seq'::regclass);

-- DEFAULT: invite_projection_outbox id

ALTER TABLE ONLY invite_projection_outbox ALTER COLUMN id SET DEFAULT nextval('invite_projection_outbox_id_seq'::regclass);

-- DEFAULT: loan_pick id

ALTER TABLE ONLY loan_pick ALTER COLUMN id SET DEFAULT nextval('loan_pick_id_seq'::regclass);

-- DEFAULT: publication_command sequence

ALTER TABLE ONLY publication_command ALTER COLUMN sequence SET DEFAULT nextval('publication_command_sequence_seq'::regclass);

-- CONSTRAINT: art_fetch_failure art_fetch_failure_pkey

ALTER TABLE ONLY art_fetch_failure
    ADD CONSTRAINT art_fetch_failure_pkey PRIMARY KEY (printing_id, size);

-- CONSTRAINT: art_hit art_hit_pkey

ALTER TABLE ONLY art_hit
    ADD CONSTRAINT art_hit_pkey PRIMARY KEY (printing_id, size);

-- CONSTRAINT: art_large_upgrade art_large_upgrade_pkey

ALTER TABLE ONLY art_large_upgrade
    ADD CONSTRAINT art_large_upgrade_pkey PRIMARY KEY (printing_id);

-- CONSTRAINT: art_object art_object_pkey

ALTER TABLE ONLY art_object
    ADD CONSTRAINT art_object_pkey PRIMARY KEY (printing_id, size);

-- CONSTRAINT: block block_pkey

ALTER TABLE ONLY block
    ADD CONSTRAINT block_pkey PRIMARY KEY (blocker_id, blocked_id);

-- CONSTRAINT: borrowed_holding borrowed_holding_once

ALTER TABLE ONLY borrowed_holding
    ADD CONSTRAINT borrowed_holding_once UNIQUE (loan_id, location_id, edition_id);

-- CONSTRAINT: borrowed_holding borrowed_holding_pkey

ALTER TABLE ONLY borrowed_holding
    ADD CONSTRAINT borrowed_holding_pkey PRIMARY KEY (id);

-- CONSTRAINT: collection_import collection_import_pkey

ALTER TABLE ONLY collection_import
    ADD CONSTRAINT collection_import_pkey PRIMARY KEY (id);

-- CONSTRAINT: collection_import_row collection_import_row_pkey

ALTER TABLE ONLY collection_import_row
    ADD CONSTRAINT collection_import_row_pkey PRIMARY KEY (import_id, row_number);

-- CONSTRAINT: collection_import_start collection_import_start_pkey

ALTER TABLE ONLY collection_import_start
    ADD CONSTRAINT collection_import_start_pkey PRIMARY KEY (id);

-- CONSTRAINT: collector_profile collector_profile_handle_key_key

ALTER TABLE ONLY collector_profile
    ADD CONSTRAINT collector_profile_handle_key_key UNIQUE (handle_key);

-- CONSTRAINT: collector_profile collector_profile_pkey

ALTER TABLE ONLY collector_profile
    ADD CONSTRAINT collector_profile_pkey PRIMARY KEY (user_id);

-- CONSTRAINT: collector_profile collector_profile_trader_id_key

ALTER TABLE ONLY collector_profile
    ADD CONSTRAINT collector_profile_trader_id_key UNIQUE (trader_id);

-- CONSTRAINT: conversation_member conversation_member_pkey

ALTER TABLE ONLY conversation_member
    ADD CONSTRAINT conversation_member_pkey PRIMARY KEY (conversation_id, member_id);

-- CONSTRAINT: conversation conversation_pair

ALTER TABLE ONLY conversation
    ADD CONSTRAINT conversation_pair UNIQUE (user_low, user_high);

-- CONSTRAINT: conversation conversation_pkey

ALTER TABLE ONLY conversation
    ADD CONSTRAINT conversation_pkey PRIMARY KEY (id);

-- CONSTRAINT: deck_cover deck_cover_pkey

ALTER TABLE ONLY deck_cover
    ADD CONSTRAINT deck_cover_pkey PRIMARY KEY (owner_id, deck_id);

-- CONSTRAINT: deck_list_line deck_list_line_pkey

ALTER TABLE ONLY deck_list_line
    ADD CONSTRAINT deck_list_line_pkey PRIMARY KEY (owner_id, deck_id, edition_id);

-- CONSTRAINT: deck_list deck_list_pkey

ALTER TABLE ONLY deck_list
    ADD CONSTRAINT deck_list_pkey PRIMARY KEY (owner_id, deck_id);

-- CONSTRAINT: deck_publication deck_publication_pkey

ALTER TABLE ONLY deck_publication
    ADD CONSTRAINT deck_publication_pkey PRIMARY KEY (token);

-- CONSTRAINT: discovery_setting discovery_setting_pkey

ALTER TABLE ONLY discovery_setting
    ADD CONSTRAINT discovery_setting_pkey PRIMARY KEY (user_id);

-- CONSTRAINT: friend_request_declined friend_request_declined_pkey

ALTER TABLE ONLY friend_request_declined
    ADD CONSTRAINT friend_request_declined_pkey PRIMARY KEY (sender_id, recipient_id);

-- CONSTRAINT: friendship friendship_pkey

ALTER TABLE ONLY friendship
    ADD CONSTRAINT friendship_pkey PRIMARY KEY (user_low, user_high);

-- CONSTRAINT: holding holding_pkey

ALTER TABLE ONLY holding
    ADD CONSTRAINT holding_pkey PRIMARY KEY (owner_id, location_id, edition_id);

-- CONSTRAINT: inbox_update inbox_update_pkey

ALTER TABLE ONLY inbox_update
    ADD CONSTRAINT inbox_update_pkey PRIMARY KEY (id);

-- CONSTRAINT: inventory_owner inventory_owner_pkey

ALTER TABLE ONLY inventory_owner
    ADD CONSTRAINT inventory_owner_pkey PRIMARY KEY (user_id);

-- CONSTRAINT: inventory_undo inventory_undo_pkey

ALTER TABLE ONLY inventory_undo
    ADD CONSTRAINT inventory_undo_pkey PRIMARY KEY (id);

-- CONSTRAINT: invite_link invite_link_pkey

ALTER TABLE ONLY invite_link
    ADD CONSTRAINT invite_link_pkey PRIMARY KEY (user_id);

-- CONSTRAINT: invite_link invite_link_token_hash_key

ALTER TABLE ONLY invite_link
    ADD CONSTRAINT invite_link_token_hash_key UNIQUE (token_hash);

-- CONSTRAINT: invite_link invite_link_token_key

ALTER TABLE ONLY invite_link
    ADD CONSTRAINT invite_link_token_key UNIQUE (token);

-- CONSTRAINT: invite_projection_outbox invite_projection_outbox_pkey

ALTER TABLE ONLY invite_projection_outbox
    ADD CONSTRAINT invite_projection_outbox_pkey PRIMARY KEY (id);

-- CONSTRAINT: legacy_contact legacy_contact_pkey

ALTER TABLE ONLY legacy_contact
    ADD CONSTRAINT legacy_contact_pkey PRIMARY KEY (user_low, user_high);

-- CONSTRAINT: loan_line loan_line_pkey

ALTER TABLE ONLY loan_line
    ADD CONSTRAINT loan_line_pkey PRIMARY KEY (loan_id, edition_id);

-- CONSTRAINT: loan_notice_seen loan_notice_seen_pkey

ALTER TABLE ONLY loan_notice_seen
    ADD CONSTRAINT loan_notice_seen_pkey PRIMARY KEY (loan_id, user_id, kind);

-- CONSTRAINT: loan_pick loan_pick_pkey

ALTER TABLE ONLY loan_pick
    ADD CONSTRAINT loan_pick_pkey PRIMARY KEY (id);

-- CONSTRAINT: loan loan_pkey

ALTER TABLE ONLY loan
    ADD CONSTRAINT loan_pkey PRIMARY KEY (id);

-- CONSTRAINT: loan_return_line loan_return_line_pkey

ALTER TABLE ONLY loan_return_line
    ADD CONSTRAINT loan_return_line_pkey PRIMARY KEY (return_id, edition_id);

-- CONSTRAINT: loan_return loan_return_pkey

ALTER TABLE ONLY loan_return
    ADD CONSTRAINT loan_return_pkey PRIMARY KEY (id);

-- CONSTRAINT: location_command location_command_pkey

ALTER TABLE ONLY location_command
    ADD CONSTRAINT location_command_pkey PRIMARY KEY (owner_id, request_key);

-- CONSTRAINT: location location_owner_identity

ALTER TABLE ONLY location
    ADD CONSTRAINT location_owner_identity UNIQUE (owner_id, id);

-- CONSTRAINT: location location_pkey

ALTER TABLE ONLY location
    ADD CONSTRAINT location_pkey PRIMARY KEY (id);

-- CONSTRAINT: message message_once

ALTER TABLE ONLY message
    ADD CONSTRAINT message_once UNIQUE (conversation_id, from_low, client_key);

-- CONSTRAINT: message message_pkey

ALTER TABLE ONLY message
    ADD CONSTRAINT message_pkey PRIMARY KEY (id);

-- CONSTRAINT: missing_card_report missing_card_report_pkey

ALTER TABLE ONLY missing_card_report
    ADD CONSTRAINT missing_card_report_pkey PRIMARY KEY (id);

-- CONSTRAINT: moderation_event moderation_event_pkey

ALTER TABLE ONLY moderation_event
    ADD CONSTRAINT moderation_event_pkey PRIMARY KEY (id);

-- CONSTRAINT: move_manifest_entry move_manifest_entry_pkey

ALTER TABLE ONLY move_manifest_entry
    ADD CONSTRAINT move_manifest_entry_pkey PRIMARY KEY (owner_id, source_id, edition_id);

-- CONSTRAINT: move_manifest move_manifest_id_key

ALTER TABLE ONLY move_manifest
    ADD CONSTRAINT move_manifest_id_key UNIQUE (id);

-- CONSTRAINT: move_manifest_item move_manifest_item_pkey

ALTER TABLE ONLY move_manifest_item
    ADD CONSTRAINT move_manifest_item_pkey PRIMARY KEY (owner_id, edition_id);

-- CONSTRAINT: move_manifest move_manifest_pkey

ALTER TABLE ONLY move_manifest
    ADD CONSTRAINT move_manifest_pkey PRIMARY KEY (owner_id);

-- CONSTRAINT: move_response move_response_pkey

ALTER TABLE ONLY move_response
    ADD CONSTRAINT move_response_pkey PRIMARY KEY (owner_id, request_key);

-- CONSTRAINT: mutation_request mutation_request_pkey

ALTER TABLE ONLY mutation_request
    ADD CONSTRAINT mutation_request_pkey PRIMARY KEY (owner_id, request_key);

-- CONSTRAINT: mutation_response mutation_response_pkey

ALTER TABLE ONLY mutation_response
    ADD CONSTRAINT mutation_response_pkey PRIMARY KEY (owner_id, request_key);

-- CONSTRAINT: operations_alert operations_alert_pkey

ALTER TABLE ONLY operations_alert
    ADD CONSTRAINT operations_alert_pkey PRIMARY KEY (id);

-- CONSTRAINT: operations_counter operations_counter_pkey

ALTER TABLE ONLY operations_counter
    ADD CONSTRAINT operations_counter_pkey PRIMARY KEY (name);

-- CONSTRAINT: operations_hour operations_hour_pkey

ALTER TABLE ONLY operations_hour
    ADD CONSTRAINT operations_hour_pkey PRIMARY KEY (hour);

-- CONSTRAINT: operations_quota operations_quota_pkey

ALTER TABLE ONLY operations_quota
    ADD CONSTRAINT operations_quota_pkey PRIMARY KEY (resource);

-- CONSTRAINT: operations_state operations_state_pkey

ALTER TABLE ONLY operations_state
    ADD CONSTRAINT operations_state_pkey PRIMARY KEY (singleton);

-- CONSTRAINT: publication_command publication_command_owner_id_request_key_key

ALTER TABLE ONLY publication_command
    ADD CONSTRAINT publication_command_owner_id_request_key_key UNIQUE (owner_id, request_key);

-- CONSTRAINT: publication_command publication_command_pkey

ALTER TABLE ONLY publication_command
    ADD CONSTRAINT publication_command_pkey PRIMARY KEY (sequence);

-- CONSTRAINT: released_handle released_handle_pkey

ALTER TABLE ONLY released_handle
    ADD CONSTRAINT released_handle_pkey PRIMARY KEY (handle_key);

-- CONSTRAINT: thread_event thread_event_pkey

ALTER TABLE ONLY thread_event
    ADD CONSTRAINT thread_event_pkey PRIMARY KEY (id);

-- CONSTRAINT: thread_event thread_event_source_key_key

ALTER TABLE ONLY thread_event
    ADD CONSTRAINT thread_event_source_key_key UNIQUE (source_key);

-- CONSTRAINT: thread thread_id_kind_key

ALTER TABLE ONLY thread
    ADD CONSTRAINT thread_id_kind_key UNIQUE (id, kind);

-- CONSTRAINT: thread_member thread_member_pkey

ALTER TABLE ONLY thread_member
    ADD CONSTRAINT thread_member_pkey PRIMARY KEY (thread_id, member_id);

-- CONSTRAINT: thread_message thread_message_pkey

ALTER TABLE ONLY thread_message
    ADD CONSTRAINT thread_message_pkey PRIMARY KEY (id);

-- CONSTRAINT: thread_message thread_message_thread_id_from_low_client_key_key

ALTER TABLE ONLY thread_message
    ADD CONSTRAINT thread_message_thread_id_from_low_client_key_key UNIQUE (thread_id, from_low, client_key);

-- CONSTRAINT: thread thread_pkey

ALTER TABLE ONLY thread
    ADD CONSTRAINT thread_pkey PRIMARY KEY (id);

-- CONSTRAINT: thread_round_source thread_round_source_pkey

ALTER TABLE ONLY thread_round_source
    ADD CONSTRAINT thread_round_source_pkey PRIMARY KEY (kind, round_id);

-- CONSTRAINT: trade_accept trade_accept_pkey

ALTER TABLE ONLY trade_accept
    ADD CONSTRAINT trade_accept_pkey PRIMARY KEY (owner_id, edition_id);

-- CONSTRAINT: trade_line trade_line_pkey

ALTER TABLE ONLY trade_line
    ADD CONSTRAINT trade_line_pkey PRIMARY KEY (trade_id, side, edition_id);

-- CONSTRAINT: trade_pick trade_pick_pkey

ALTER TABLE ONLY trade_pick
    ADD CONSTRAINT trade_pick_pkey PRIMARY KEY (id);

-- CONSTRAINT: trade trade_pkey

ALTER TABLE ONLY trade
    ADD CONSTRAINT trade_pkey PRIMARY KEY (id);

-- CONSTRAINT: trade_report_message trade_report_message_pkey

ALTER TABLE ONLY trade_report_message
    ADD CONSTRAINT trade_report_message_pkey PRIMARY KEY (report_id, message_id);

-- CONSTRAINT: trade_report trade_report_pkey

ALTER TABLE ONLY trade_report
    ADD CONSTRAINT trade_report_pkey PRIMARY KEY (id);

-- CONSTRAINT: trade_report_trade trade_report_trade_pkey

ALTER TABLE ONLY trade_report_trade
    ADD CONSTRAINT trade_report_trade_pkey PRIMARY KEY (report_id, trade_id);

-- CONSTRAINT: trade_want trade_want_pkey

ALTER TABLE ONLY trade_want
    ADD CONSTRAINT trade_want_pkey PRIMARY KEY (owner_id, edition_id);

-- CONSTRAINT: zip_centroid zip_centroid_pkey

ALTER TABLE ONLY zip_centroid
    ADD CONSTRAINT zip_centroid_pkey PRIMARY KEY (zip);

-- INDEX: block_blocked

CREATE INDEX block_blocked ON block USING btree (blocked_id);

-- INDEX: block_id_unique

CREATE UNIQUE INDEX block_id_unique ON block USING btree (id);

-- INDEX: borrowed_holding_location_index

CREATE INDEX borrowed_holding_location_index ON borrowed_holding USING btree (location_id);

-- INDEX: borrowed_holding_place

CREATE INDEX borrowed_holding_place ON borrowed_holding USING btree (borrower_id, location_id);

-- INDEX: collection_import_expiry

CREATE INDEX collection_import_expiry ON collection_import USING btree (expires_at);

-- INDEX: collection_import_one_open_per_owner

CREATE UNIQUE INDEX collection_import_one_open_per_owner ON collection_import USING btree (owner_id) WHERE (status = 'open'::text);

-- INDEX: collection_import_start_owner

CREATE INDEX collection_import_start_owner ON collection_import_start USING btree (owner_id, started_at);

-- INDEX: conversation_member_member

CREATE INDEX conversation_member_member ON conversation_member USING btree (member_id);

-- INDEX: conversation_user_high

CREATE INDEX conversation_user_high ON conversation USING btree (user_high);

-- INDEX: deck_publication_deck

CREATE INDEX deck_publication_deck ON deck_publication USING btree (deck_id);

-- INDEX: deck_publication_owner_active

CREATE INDEX deck_publication_owner_active ON deck_publication USING btree (owner_id, created_at, token) WHERE (NOT revoked);

-- INDEX: discovery_open_lat

CREATE INDEX discovery_open_lat ON discovery_setting USING btree (lat) WHERE enabled;

-- INDEX: friend_request_declined_recipient

CREATE INDEX friend_request_declined_recipient ON friend_request_declined USING btree (recipient_id);

-- INDEX: friendship_high

CREATE INDEX friendship_high ON friendship USING btree (user_high);

-- INDEX: handle_lookup_event_recent

CREATE INDEX handle_lookup_event_recent ON handle_lookup_event USING btree (user_id, kind, created_at);

-- INDEX: holding_owner_edition_location

CREATE INDEX holding_owner_edition_location ON holding USING btree (owner_id, edition_id, location_id);

-- INDEX: holding_owner_leaf_quantity

CREATE INDEX holding_owner_leaf_quantity ON holding USING btree (owner_id, location_id, quantity DESC, edition_id);

-- INDEX: inbox_update_loan

CREATE INDEX inbox_update_loan ON inbox_update USING btree (loan_id);

-- INDEX: inbox_update_recipient

CREATE INDEX inbox_update_recipient ON inbox_update USING btree (recipient_id, created_at DESC);

-- INDEX: inbox_update_trade

CREATE INDEX inbox_update_trade ON inbox_update USING btree (trade_id);

-- INDEX: inventory_undo_expiry

CREATE INDEX inventory_undo_expiry ON inventory_undo USING btree (expires_at);

-- INDEX: inventory_undo_owner

CREATE INDEX inventory_undo_owner ON inventory_undo USING btree (owner_id, created_at DESC);

-- INDEX: legacy_contact_high

CREATE INDEX legacy_contact_high ON legacy_contact USING btree (user_high);

-- INDEX: loan_borrower

CREATE INDEX loan_borrower ON loan USING btree (borrower_id, created_at DESC);

-- INDEX: loan_lender

CREATE INDEX loan_lender ON loan USING btree (lender_id, created_at DESC);

-- INDEX: loan_line_edition

CREATE INDEX loan_line_edition ON loan_line USING btree (edition_id);

-- INDEX: loan_one_live

CREATE UNIQUE INDEX loan_one_live ON loan USING btree (thread_id) WHERE (state <> 'closed'::text);

-- INDEX: loan_pick_loan

CREATE INDEX loan_pick_loan ON loan_pick USING btree (loan_id, edition_id);

-- INDEX: loan_pick_source_index

CREATE INDEX loan_pick_source_index ON loan_pick USING btree (owner_id, source_location_id);

-- INDEX: loan_reserving

CREATE INDEX loan_reserving ON loan USING btree (lender_id) WHERE ((state = ANY (ARRAY['offered'::text, 'accepted'::text])) AND (lender_handover_at IS NULL));

-- INDEX: loan_return_line_loan

CREATE INDEX loan_return_line_loan ON loan_return_line USING btree (loan_id, edition_id);

-- INDEX: loan_return_loan

CREATE INDEX loan_return_loan ON loan_return USING btree (loan_id, created_at);

-- INDEX: loan_return_pending

CREATE UNIQUE INDEX loan_return_pending ON loan_return USING btree (loan_id) WHERE (completed_at IS NULL);

-- INDEX: location_for_trade

CREATE INDEX location_for_trade ON location USING btree (owner_id) WHERE for_trade;

-- INDEX: location_hidden

CREATE INDEX location_hidden ON location USING btree (owner_id) WHERE hidden;

-- INDEX: location_owner_decks

CREATE INDEX location_owner_decks ON location USING btree (owner_id, lower(name), id) WHERE (kind = 'deck'::text);

-- INDEX: location_owner_parent

CREATE INDEX location_owner_parent ON location USING btree (owner_id, parent_id);

-- INDEX: location_unique_sibling_name

CREATE UNIQUE INDEX location_unique_sibling_name ON location USING btree (owner_id, COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(btrim(name)));

-- INDEX: message_timeline

CREATE INDEX message_timeline ON message USING btree (conversation_id, created_at DESC, id DESC);

-- INDEX: missing_report_queue

CREATE INDEX missing_report_queue ON missing_card_report USING btree (status, created_at);

-- INDEX: missing_report_reporter

CREATE INDEX missing_report_reporter ON missing_card_report USING btree (reporter_id, created_at DESC);

-- INDEX: moderation_event_report

CREATE INDEX moderation_event_report ON moderation_event USING btree (report_id);

-- INDEX: moderation_event_subject

CREATE INDEX moderation_event_subject ON moderation_event USING btree (subject_id, created_at);

-- INDEX: move_manifest_expiry

CREATE INDEX move_manifest_expiry ON move_manifest USING btree (expires_at);

-- INDEX: mutation_request_expiry

CREATE INDEX mutation_request_expiry ON mutation_request USING btree (expires_at);

-- INDEX: one_active_backup_alert

CREATE UNIQUE INDEX one_active_backup_alert ON operations_alert USING btree (kind) WHERE (resolved_at IS NULL);

-- INDEX: one_active_deck_publication

CREATE UNIQUE INDEX one_active_deck_publication ON deck_publication USING btree (deck_id) WHERE (NOT revoked);

-- INDEX: one_unsorted_root_per_owner

CREATE UNIQUE INDEX one_unsorted_root_per_owner ON location USING btree (owner_id, name) WHERE ((parent_id IS NULL) AND (name = 'Unsorted'::text));

-- INDEX: publication_pending_projection

CREATE INDEX publication_pending_projection ON publication_command USING btree (sequence) WHERE (NOT projected);

-- INDEX: thread_event_timeline

CREATE INDEX thread_event_timeline ON thread_event USING btree (thread_id, created_at DESC, id DESC);

-- INDEX: thread_high

CREATE INDEX thread_high ON thread USING btree (user_high, last_activity_at DESC, id DESC);

-- INDEX: thread_low

CREATE INDEX thread_low ON thread USING btree (user_low, last_activity_at DESC, id DESC);

-- INDEX: thread_member_member

CREATE INDEX thread_member_member ON thread_member USING btree (member_id);

-- INDEX: thread_message_timeline

CREATE INDEX thread_message_timeline ON thread_message USING btree (thread_id, created_at DESC, id DESC);

-- INDEX: thread_pair

CREATE INDEX thread_pair ON thread USING btree (user_low, user_high);

-- INDEX: trade_completed_proposer

CREATE INDEX trade_completed_proposer ON trade USING btree (proposer_id) WHERE ((proposer_swap_at IS NOT NULL) AND (recipient_swap_at IS NOT NULL));

-- INDEX: trade_completed_recipient

CREATE INDEX trade_completed_recipient ON trade USING btree (recipient_id) WHERE ((proposer_swap_at IS NOT NULL) AND (recipient_swap_at IS NOT NULL));

-- INDEX: trade_conversation

CREATE INDEX trade_conversation ON trade USING btree (conversation_id, created_at DESC);

-- INDEX: trade_counter_chain

CREATE INDEX trade_counter_chain ON trade USING btree (countered_from);

-- INDEX: trade_one_live

CREATE UNIQUE INDEX trade_one_live ON trade USING btree (thread_id) WHERE (state <> 'closed'::text);

-- INDEX: trade_pick_source_index

CREATE INDEX trade_pick_source_index ON trade_pick USING btree (owner_id, source_location_id);

-- INDEX: trade_pick_trade

CREATE INDEX trade_pick_trade ON trade_pick USING btree (trade_id, side);

-- INDEX: trade_proposer

CREATE INDEX trade_proposer ON trade USING btree (proposer_id, created_at DESC);

-- INDEX: trade_recipient

CREATE INDEX trade_recipient ON trade USING btree (recipient_id, created_at DESC);

-- INDEX: trade_report_queue

CREATE INDEX trade_report_queue ON trade_report USING btree (status, created_at);

-- INDEX: trade_report_reported

CREATE INDEX trade_report_reported ON trade_report USING btree (reported_id, created_at);

-- INDEX: trade_report_reporter

CREATE INDEX trade_report_reporter ON trade_report USING btree (reporter_id);

-- INDEX: trade_reserving_proposer

CREATE INDEX trade_reserving_proposer ON trade USING btree (proposer_id) WHERE ((state = ANY (ARRAY['proposed'::text, 'accepted'::text])) AND (proposer_swap_at IS NULL));

-- INDEX: trade_reserving_recipient

CREATE INDEX trade_reserving_recipient ON trade USING btree (recipient_id) WHERE ((state = 'accepted'::text) AND (recipient_swap_at IS NULL));

-- FK CONSTRAINT: block block_blocked_id_fkey

ALTER TABLE ONLY block
    ADD CONSTRAINT block_blocked_id_fkey FOREIGN KEY (blocked_id) REFERENCES collector_profile(user_id) ON DELETE CASCADE;

-- FK CONSTRAINT: block block_blocker_id_fkey

ALTER TABLE ONLY block
    ADD CONSTRAINT block_blocker_id_fkey FOREIGN KEY (blocker_id) REFERENCES collector_profile(user_id) ON DELETE CASCADE;

-- FK CONSTRAINT: borrowed_holding borrowed_holding_borrower_id_fkey

ALTER TABLE ONLY borrowed_holding
    ADD CONSTRAINT borrowed_holding_borrower_id_fkey FOREIGN KEY (borrower_id) REFERENCES inventory_owner(user_id) ON DELETE CASCADE;

-- FK CONSTRAINT: borrowed_holding borrowed_holding_loan_id_fkey

ALTER TABLE ONLY borrowed_holding
    ADD CONSTRAINT borrowed_holding_loan_id_fkey FOREIGN KEY (loan_id) REFERENCES loan(id);

-- FK CONSTRAINT: borrowed_holding borrowed_holding_location

ALTER TABLE ONLY borrowed_holding
    ADD CONSTRAINT borrowed_holding_location FOREIGN KEY (borrower_id, location_id) REFERENCES location(owner_id, id) ON DELETE RESTRICT;

-- FK CONSTRAINT: collection_import collection_import_owner_id_fkey

ALTER TABLE ONLY collection_import
    ADD CONSTRAINT collection_import_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES inventory_owner(user_id) ON DELETE CASCADE;

-- FK CONSTRAINT: collection_import_row collection_import_row_import_id_fkey

ALTER TABLE ONLY collection_import_row
    ADD CONSTRAINT collection_import_row_import_id_fkey FOREIGN KEY (import_id) REFERENCES collection_import(id) ON DELETE CASCADE;

-- FK CONSTRAINT: collection_import_start collection_import_start_owner_id_fkey

ALTER TABLE ONLY collection_import_start
    ADD CONSTRAINT collection_import_start_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES inventory_owner(user_id) ON DELETE CASCADE;

-- FK CONSTRAINT: collector_profile collector_profile_user_id_fkey

ALTER TABLE ONLY collector_profile
    ADD CONSTRAINT collector_profile_user_id_fkey FOREIGN KEY (user_id) REFERENCES inventory_owner(user_id) ON DELETE CASCADE;

-- FK CONSTRAINT: conversation_member conversation_member_conversation_id_fkey

ALTER TABLE ONLY conversation_member
    ADD CONSTRAINT conversation_member_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES conversation(id) ON DELETE CASCADE;

-- FK CONSTRAINT: conversation_member conversation_member_member_id_fkey

ALTER TABLE ONLY conversation_member
    ADD CONSTRAINT conversation_member_member_id_fkey FOREIGN KEY (member_id) REFERENCES inventory_owner(user_id) ON DELETE CASCADE;

-- FK CONSTRAINT: conversation conversation_user_high_fkey

ALTER TABLE ONLY conversation
    ADD CONSTRAINT conversation_user_high_fkey FOREIGN KEY (user_high) REFERENCES inventory_owner(user_id) ON DELETE SET NULL;

-- FK CONSTRAINT: conversation conversation_user_low_fkey

ALTER TABLE ONLY conversation
    ADD CONSTRAINT conversation_user_low_fkey FOREIGN KEY (user_low) REFERENCES inventory_owner(user_id) ON DELETE SET NULL;

-- FK CONSTRAINT: deck_cover deck_cover_owner_id_deck_id_edition_id_fkey

ALTER TABLE ONLY deck_cover
    ADD CONSTRAINT deck_cover_owner_id_deck_id_edition_id_fkey FOREIGN KEY (owner_id, deck_id, edition_id) REFERENCES deck_list_line(owner_id, deck_id, edition_id) ON DELETE CASCADE;

-- FK CONSTRAINT: deck_list_line deck_list_line_owner_id_deck_id_fkey

ALTER TABLE ONLY deck_list_line
    ADD CONSTRAINT deck_list_line_owner_id_deck_id_fkey FOREIGN KEY (owner_id, deck_id) REFERENCES deck_list(owner_id, deck_id) ON DELETE CASCADE;

-- FK CONSTRAINT: deck_list deck_list_owner_id_deck_id_fkey

ALTER TABLE ONLY deck_list
    ADD CONSTRAINT deck_list_owner_id_deck_id_fkey FOREIGN KEY (owner_id, deck_id) REFERENCES location(owner_id, id) ON DELETE CASCADE;

-- FK CONSTRAINT: deck_publication deck_publication_deck_id_fkey

ALTER TABLE ONLY deck_publication
    ADD CONSTRAINT deck_publication_deck_id_fkey FOREIGN KEY (deck_id) REFERENCES location(id) ON DELETE SET NULL;

-- FK CONSTRAINT: deck_publication deck_publication_owner_id_fkey

ALTER TABLE ONLY deck_publication
    ADD CONSTRAINT deck_publication_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES inventory_owner(user_id);

-- FK CONSTRAINT: discovery_setting discovery_setting_user_id_fkey

ALTER TABLE ONLY discovery_setting
    ADD CONSTRAINT discovery_setting_user_id_fkey FOREIGN KEY (user_id) REFERENCES collector_profile(user_id) ON DELETE CASCADE;

-- FK CONSTRAINT: friend_request_declined friend_request_declined_recipient_id_fkey

ALTER TABLE ONLY friend_request_declined
    ADD CONSTRAINT friend_request_declined_recipient_id_fkey FOREIGN KEY (recipient_id) REFERENCES collector_profile(user_id) ON DELETE CASCADE;

-- FK CONSTRAINT: friend_request_declined friend_request_declined_sender_id_fkey

ALTER TABLE ONLY friend_request_declined
    ADD CONSTRAINT friend_request_declined_sender_id_fkey FOREIGN KEY (sender_id) REFERENCES collector_profile(user_id) ON DELETE CASCADE;

-- FK CONSTRAINT: friendship friendship_user_high_fkey

ALTER TABLE ONLY friendship
    ADD CONSTRAINT friendship_user_high_fkey FOREIGN KEY (user_high) REFERENCES collector_profile(user_id) ON DELETE CASCADE;

-- FK CONSTRAINT: friendship friendship_user_low_fkey

ALTER TABLE ONLY friendship
    ADD CONSTRAINT friendship_user_low_fkey FOREIGN KEY (user_low) REFERENCES collector_profile(user_id) ON DELETE CASCADE;

-- FK CONSTRAINT: handle_lookup_event handle_lookup_event_user_id_fkey

ALTER TABLE ONLY handle_lookup_event
    ADD CONSTRAINT handle_lookup_event_user_id_fkey FOREIGN KEY (user_id) REFERENCES inventory_owner(user_id) ON DELETE CASCADE;

-- FK CONSTRAINT: holding holding_owner_id_fkey

ALTER TABLE ONLY holding
    ADD CONSTRAINT holding_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES inventory_owner(user_id) ON DELETE CASCADE;

-- FK CONSTRAINT: holding holding_owner_id_location_id_fkey

ALTER TABLE ONLY holding
    ADD CONSTRAINT holding_owner_id_location_id_fkey FOREIGN KEY (owner_id, location_id) REFERENCES location(owner_id, id) ON DELETE RESTRICT;

-- FK CONSTRAINT: inbox_update inbox_update_loan_id_fkey

ALTER TABLE ONLY inbox_update
    ADD CONSTRAINT inbox_update_loan_id_fkey FOREIGN KEY (loan_id) REFERENCES loan(id) ON DELETE CASCADE;

-- FK CONSTRAINT: inbox_update inbox_update_trade_id_fkey

ALTER TABLE ONLY inbox_update
    ADD CONSTRAINT inbox_update_trade_id_fkey FOREIGN KEY (trade_id) REFERENCES trade(id) ON DELETE CASCADE;

-- FK CONSTRAINT: inventory_undo inventory_undo_owner_id_fkey

ALTER TABLE ONLY inventory_undo
    ADD CONSTRAINT inventory_undo_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES inventory_owner(user_id) ON DELETE CASCADE;

-- FK CONSTRAINT: invite_link invite_link_user_id_fkey

ALTER TABLE ONLY invite_link
    ADD CONSTRAINT invite_link_user_id_fkey FOREIGN KEY (user_id) REFERENCES collector_profile(user_id) ON DELETE CASCADE;

-- FK CONSTRAINT: legacy_contact legacy_contact_user_high_fkey

ALTER TABLE ONLY legacy_contact
    ADD CONSTRAINT legacy_contact_user_high_fkey FOREIGN KEY (user_high) REFERENCES inventory_owner(user_id) ON DELETE CASCADE;

-- FK CONSTRAINT: legacy_contact legacy_contact_user_low_fkey

ALTER TABLE ONLY legacy_contact
    ADD CONSTRAINT legacy_contact_user_low_fkey FOREIGN KEY (user_low) REFERENCES inventory_owner(user_id) ON DELETE CASCADE;

-- FK CONSTRAINT: loan loan_borrower_deck

ALTER TABLE ONLY loan
    ADD CONSTRAINT loan_borrower_deck FOREIGN KEY (borrower_id, deck_id) REFERENCES location(owner_id, id) ON DELETE SET NULL (deck_id);

-- FK CONSTRAINT: loan loan_borrower_id_fkey

ALTER TABLE ONLY loan
    ADD CONSTRAINT loan_borrower_id_fkey FOREIGN KEY (borrower_id) REFERENCES inventory_owner(user_id) ON DELETE SET NULL;

-- FK CONSTRAINT: loan loan_lender_id_fkey

ALTER TABLE ONLY loan
    ADD CONSTRAINT loan_lender_id_fkey FOREIGN KEY (lender_id) REFERENCES inventory_owner(user_id) ON DELETE SET NULL;

-- FK CONSTRAINT: loan_line loan_line_loan_id_fkey

ALTER TABLE ONLY loan_line
    ADD CONSTRAINT loan_line_loan_id_fkey FOREIGN KEY (loan_id) REFERENCES loan(id) ON DELETE CASCADE;

-- FK CONSTRAINT: loan_notice_seen loan_notice_seen_loan_id_fkey

ALTER TABLE ONLY loan_notice_seen
    ADD CONSTRAINT loan_notice_seen_loan_id_fkey FOREIGN KEY (loan_id) REFERENCES loan(id) ON DELETE CASCADE;

-- FK CONSTRAINT: loan_notice_seen loan_notice_seen_user_id_fkey

ALTER TABLE ONLY loan_notice_seen
    ADD CONSTRAINT loan_notice_seen_user_id_fkey FOREIGN KEY (user_id) REFERENCES inventory_owner(user_id) ON DELETE CASCADE;

-- FK CONSTRAINT: loan_pick loan_pick_loan_id_edition_id_fkey

ALTER TABLE ONLY loan_pick
    ADD CONSTRAINT loan_pick_loan_id_edition_id_fkey FOREIGN KEY (loan_id, edition_id) REFERENCES loan_line(loan_id, edition_id) ON DELETE CASCADE;

-- FK CONSTRAINT: loan_pick loan_pick_owner_id_fkey

ALTER TABLE ONLY loan_pick
    ADD CONSTRAINT loan_pick_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES inventory_owner(user_id) ON DELETE CASCADE;

-- FK CONSTRAINT: loan_pick loan_pick_source

ALTER TABLE ONLY loan_pick
    ADD CONSTRAINT loan_pick_source FOREIGN KEY (owner_id, source_location_id) REFERENCES location(owner_id, id) ON DELETE SET NULL (source_location_id);

-- FK CONSTRAINT: loan_return_line loan_return_line_loan_id_edition_id_fkey

ALTER TABLE ONLY loan_return_line
    ADD CONSTRAINT loan_return_line_loan_id_edition_id_fkey FOREIGN KEY (loan_id, edition_id) REFERENCES loan_line(loan_id, edition_id) ON DELETE CASCADE;

-- FK CONSTRAINT: loan_return_line loan_return_line_return_id_fkey

ALTER TABLE ONLY loan_return_line
    ADD CONSTRAINT loan_return_line_return_id_fkey FOREIGN KEY (return_id) REFERENCES loan_return(id) ON DELETE CASCADE;

-- FK CONSTRAINT: loan_return loan_return_loan_id_fkey

ALTER TABLE ONLY loan_return
    ADD CONSTRAINT loan_return_loan_id_fkey FOREIGN KEY (loan_id) REFERENCES loan(id) ON DELETE CASCADE;

-- FK CONSTRAINT: loan loan_thread

ALTER TABLE ONLY loan
    ADD CONSTRAINT loan_thread FOREIGN KEY (thread_id, thread_kind) REFERENCES thread(id, kind);

-- FK CONSTRAINT: location_command location_command_owner_id_fkey

ALTER TABLE ONLY location_command
    ADD CONSTRAINT location_command_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES inventory_owner(user_id) ON DELETE CASCADE;

-- FK CONSTRAINT: location location_owner_id_fkey

ALTER TABLE ONLY location
    ADD CONSTRAINT location_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES inventory_owner(user_id) ON DELETE CASCADE;

-- FK CONSTRAINT: location location_parent_id_fkey

ALTER TABLE ONLY location
    ADD CONSTRAINT location_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES location(id);

-- FK CONSTRAINT: message message_conversation_id_fkey

ALTER TABLE ONLY message
    ADD CONSTRAINT message_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES conversation(id) ON DELETE CASCADE;

-- FK CONSTRAINT: missing_card_report missing_card_report_reporter_id_fkey

ALTER TABLE ONLY missing_card_report
    ADD CONSTRAINT missing_card_report_reporter_id_fkey FOREIGN KEY (reporter_id) REFERENCES inventory_owner(user_id) ON DELETE SET NULL;

-- FK CONSTRAINT: missing_card_report missing_card_report_reviewer_id_fkey

ALTER TABLE ONLY missing_card_report
    ADD CONSTRAINT missing_card_report_reviewer_id_fkey FOREIGN KEY (reviewer_id) REFERENCES inventory_owner(user_id);

-- FK CONSTRAINT: move_manifest_entry move_manifest_entry_owner_id_fkey

ALTER TABLE ONLY move_manifest_entry
    ADD CONSTRAINT move_manifest_entry_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES move_manifest(owner_id) ON DELETE CASCADE;

-- FK CONSTRAINT: move_manifest_item move_manifest_item_owner_id_fkey

ALTER TABLE ONLY move_manifest_item
    ADD CONSTRAINT move_manifest_item_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES move_manifest(owner_id) ON DELETE CASCADE;

-- FK CONSTRAINT: move_manifest move_manifest_owner_id_fkey

ALTER TABLE ONLY move_manifest
    ADD CONSTRAINT move_manifest_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES inventory_owner(user_id) ON DELETE CASCADE;

-- FK CONSTRAINT: move_manifest move_manifest_owner_id_source_id_fkey

ALTER TABLE ONLY move_manifest
    ADD CONSTRAINT move_manifest_owner_id_source_id_fkey FOREIGN KEY (owner_id, source_id) REFERENCES location(owner_id, id) ON DELETE CASCADE;

-- FK CONSTRAINT: move_response move_response_owner_id_request_key_fkey

ALTER TABLE ONLY move_response
    ADD CONSTRAINT move_response_owner_id_request_key_fkey FOREIGN KEY (owner_id, request_key) REFERENCES mutation_request(owner_id, request_key) ON DELETE CASCADE;

-- FK CONSTRAINT: mutation_request mutation_request_owner_id_fkey

ALTER TABLE ONLY mutation_request
    ADD CONSTRAINT mutation_request_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES inventory_owner(user_id) ON DELETE CASCADE;

-- FK CONSTRAINT: mutation_response mutation_response_owner_id_request_key_fkey

ALTER TABLE ONLY mutation_response
    ADD CONSTRAINT mutation_response_owner_id_request_key_fkey FOREIGN KEY (owner_id, request_key) REFERENCES mutation_request(owner_id, request_key) ON DELETE CASCADE;

-- FK CONSTRAINT: publication_command publication_command_owner_id_fkey

ALTER TABLE ONLY publication_command
    ADD CONSTRAINT publication_command_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES inventory_owner(user_id);

-- FK CONSTRAINT: publication_command publication_command_token_fkey

ALTER TABLE ONLY publication_command
    ADD CONSTRAINT publication_command_token_fkey FOREIGN KEY (token) REFERENCES deck_publication(token);

-- FK CONSTRAINT: thread_event thread_event_thread_id_fkey

ALTER TABLE ONLY thread_event
    ADD CONSTRAINT thread_event_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES thread(id);

-- FK CONSTRAINT: thread_member thread_member_member_id_fkey

ALTER TABLE ONLY thread_member
    ADD CONSTRAINT thread_member_member_id_fkey FOREIGN KEY (member_id) REFERENCES inventory_owner(user_id) ON DELETE CASCADE;

-- FK CONSTRAINT: thread_member thread_member_thread_id_fkey

ALTER TABLE ONLY thread_member
    ADD CONSTRAINT thread_member_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES thread(id);

-- FK CONSTRAINT: thread_message thread_message_thread_id_fkey

ALTER TABLE ONLY thread_message
    ADD CONSTRAINT thread_message_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES thread(id);

-- FK CONSTRAINT: thread_round_source thread_round_source_thread_id_kind_fkey

ALTER TABLE ONLY thread_round_source
    ADD CONSTRAINT thread_round_source_thread_id_kind_fkey FOREIGN KEY (thread_id, kind) REFERENCES thread(id, kind);

-- FK CONSTRAINT: thread thread_user_high_fkey

ALTER TABLE ONLY thread
    ADD CONSTRAINT thread_user_high_fkey FOREIGN KEY (user_high) REFERENCES inventory_owner(user_id) ON DELETE SET NULL;

-- FK CONSTRAINT: thread thread_user_low_fkey

ALTER TABLE ONLY thread
    ADD CONSTRAINT thread_user_low_fkey FOREIGN KEY (user_low) REFERENCES inventory_owner(user_id) ON DELETE SET NULL;

-- FK CONSTRAINT: trade_accept trade_accept_owner_id_fkey

ALTER TABLE ONLY trade_accept
    ADD CONSTRAINT trade_accept_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES inventory_owner(user_id) ON DELETE CASCADE;

-- FK CONSTRAINT: trade trade_conversation_id_fkey

ALTER TABLE ONLY trade
    ADD CONSTRAINT trade_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES conversation(id) ON DELETE SET NULL;

-- FK CONSTRAINT: trade trade_countered_from_fkey

ALTER TABLE ONLY trade
    ADD CONSTRAINT trade_countered_from_fkey FOREIGN KEY (countered_from) REFERENCES trade(id) ON DELETE SET NULL;

-- FK CONSTRAINT: trade_line trade_line_trade_id_fkey

ALTER TABLE ONLY trade_line
    ADD CONSTRAINT trade_line_trade_id_fkey FOREIGN KEY (trade_id) REFERENCES trade(id) ON DELETE CASCADE;

-- FK CONSTRAINT: trade_pick trade_pick_owner_id_fkey

ALTER TABLE ONLY trade_pick
    ADD CONSTRAINT trade_pick_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES inventory_owner(user_id) ON DELETE CASCADE;

-- FK CONSTRAINT: trade_pick trade_pick_source

ALTER TABLE ONLY trade_pick
    ADD CONSTRAINT trade_pick_source FOREIGN KEY (owner_id, source_location_id) REFERENCES location(owner_id, id) ON DELETE SET NULL (source_location_id);

-- FK CONSTRAINT: trade_pick trade_pick_trade_id_side_edition_id_fkey

ALTER TABLE ONLY trade_pick
    ADD CONSTRAINT trade_pick_trade_id_side_edition_id_fkey FOREIGN KEY (trade_id, side, edition_id) REFERENCES trade_line(trade_id, side, edition_id) ON DELETE CASCADE;

-- FK CONSTRAINT: trade trade_proposer_id_fkey

ALTER TABLE ONLY trade
    ADD CONSTRAINT trade_proposer_id_fkey FOREIGN KEY (proposer_id) REFERENCES inventory_owner(user_id) ON DELETE SET NULL;

-- FK CONSTRAINT: trade trade_recipient_id_fkey

ALTER TABLE ONLY trade
    ADD CONSTRAINT trade_recipient_id_fkey FOREIGN KEY (recipient_id) REFERENCES inventory_owner(user_id) ON DELETE SET NULL;

-- FK CONSTRAINT: trade_report_message trade_report_message_report_id_fkey

ALTER TABLE ONLY trade_report_message
    ADD CONSTRAINT trade_report_message_report_id_fkey FOREIGN KEY (report_id) REFERENCES trade_report(id) ON DELETE CASCADE;

-- FK CONSTRAINT: trade_report trade_report_reported_id_fkey

ALTER TABLE ONLY trade_report
    ADD CONSTRAINT trade_report_reported_id_fkey FOREIGN KEY (reported_id) REFERENCES inventory_owner(user_id) ON DELETE SET NULL;

-- FK CONSTRAINT: trade_report trade_report_reporter_id_fkey

ALTER TABLE ONLY trade_report
    ADD CONSTRAINT trade_report_reporter_id_fkey FOREIGN KEY (reporter_id) REFERENCES inventory_owner(user_id) ON DELETE SET NULL;

-- FK CONSTRAINT: trade_report_trade trade_report_trade_report_id_fkey

ALTER TABLE ONLY trade_report_trade
    ADD CONSTRAINT trade_report_trade_report_id_fkey FOREIGN KEY (report_id) REFERENCES trade_report(id) ON DELETE CASCADE;

-- FK CONSTRAINT: trade trade_thread

ALTER TABLE ONLY trade
    ADD CONSTRAINT trade_thread FOREIGN KEY (thread_id, thread_kind) REFERENCES thread(id, kind);

-- FK CONSTRAINT: trade_want trade_want_owner_id_fkey

ALTER TABLE ONLY trade_want
    ADD CONSTRAINT trade_want_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES inventory_owner(user_id) ON DELETE CASCADE;

-- TRIGGER: borrowed_holding borrowed_holding_deck_list_insert

CREATE TRIGGER borrowed_holding_deck_list_insert AFTER INSERT ON borrowed_holding REFERENCING NEW TABLE AS new_borrowed FOR EACH STATEMENT EXECUTE FUNCTION deck_list_cover_borrowed();

-- TRIGGER: borrowed_holding borrowed_holding_deck_list_update

CREATE TRIGGER borrowed_holding_deck_list_update AFTER UPDATE ON borrowed_holding REFERENCING OLD TABLE AS old_borrowed NEW TABLE AS new_borrowed FOR EACH STATEMENT EXECUTE FUNCTION deck_list_cover_borrowed();

-- TRIGGER: borrowed_holding borrowed_holding_leaf_guard_trigger

CREATE CONSTRAINT TRIGGER borrowed_holding_leaf_guard_trigger AFTER INSERT OR UPDATE ON borrowed_holding DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION borrowed_holding_leaf_guard();

-- TRIGGER: collector_profile collector_profile_loan_names

CREATE TRIGGER collector_profile_loan_names AFTER UPDATE OF display_name ON collector_profile FOR EACH ROW WHEN ((old.display_name IS DISTINCT FROM new.display_name)) EXECUTE FUNCTION loan_names_follow_profile();

-- TRIGGER: conversation conversation_archived

CREATE TRIGGER conversation_archived BEFORE INSERT OR DELETE OR UPDATE ON conversation FOR EACH ROW EXECUTE FUNCTION conversation_archived();

-- TRIGGER: conversation_member conversation_archived

CREATE TRIGGER conversation_archived BEFORE INSERT OR DELETE OR UPDATE ON conversation_member FOR EACH ROW EXECUTE FUNCTION conversation_archived();

-- TRIGGER: message conversation_archived

CREATE TRIGGER conversation_archived BEFORE INSERT OR DELETE OR UPDATE ON message FOR EACH ROW EXECUTE FUNCTION conversation_archived();

-- TRIGGER: holding holding_deck_list_insert

CREATE TRIGGER holding_deck_list_insert AFTER INSERT ON holding REFERENCING NEW TABLE AS new_holding FOR EACH STATEMENT EXECUTE FUNCTION deck_list_cover_holdings();

-- TRIGGER: holding holding_deck_list_update

CREATE TRIGGER holding_deck_list_update AFTER UPDATE ON holding REFERENCING OLD TABLE AS old_holding NEW TABLE AS new_holding FOR EACH STATEMENT EXECUTE FUNCTION deck_list_cover_holdings();

-- TRIGGER: holding holding_leaf_guard_trigger

CREATE CONSTRAINT TRIGGER holding_leaf_guard_trigger AFTER INSERT OR UPDATE ON holding DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION holding_leaf_guard();

-- TRIGGER: holding holding_promise_guard_delete

CREATE CONSTRAINT TRIGGER holding_promise_guard_delete AFTER DELETE ON holding DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION holding_promise_guard();

-- TRIGGER: holding holding_promise_guard_update

CREATE CONSTRAINT TRIGGER holding_promise_guard_update AFTER UPDATE ON holding DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (((new.quantity < old.quantity) OR (new.edition_id IS DISTINCT FROM old.edition_id) OR (new.owner_id IS DISTINCT FROM old.owner_id))) EXECUTE FUNCTION holding_promise_guard();

-- TRIGGER: inventory_owner inventory_undo_cleanup

CREATE TRIGGER inventory_undo_cleanup AFTER UPDATE OF revision ON inventory_owner FOR EACH ROW EXECUTE FUNCTION cleanup_inventory_undo();

-- TRIGGER: loan_line loan_line_promise_guard_trigger

CREATE CONSTRAINT TRIGGER loan_line_promise_guard_trigger AFTER INSERT OR UPDATE OF promised, edition_id ON loan_line DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION loan_line_promise_guard();

-- TRIGGER: loan loan_promise_guard_trigger

CREATE CONSTRAINT TRIGGER loan_promise_guard_trigger AFTER INSERT OR UPDATE OF state, lender_handover_at, lender_id ON loan DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION loan_promise_guard();

-- TRIGGER: location location_deck_list

CREATE TRIGGER location_deck_list AFTER INSERT ON location FOR EACH ROW WHEN ((new.kind = 'deck'::text)) EXECUTE FUNCTION create_deck_list();

-- TRIGGER: moderation_event moderation_event_append_only

CREATE TRIGGER moderation_event_append_only BEFORE DELETE OR UPDATE ON moderation_event FOR EACH ROW EXECUTE FUNCTION moderation_event_append_only();

-- TRIGGER: move_manifest_item move_manifest_item_mirror

CREATE TRIGGER move_manifest_item_mirror AFTER INSERT ON move_manifest_item REFERENCING NEW TABLE AS staged FOR EACH STATEMENT EXECUTE FUNCTION mirror_move_manifest_item();

-- TRIGGER: inventory_owner onboard_collector_profile

CREATE TRIGGER onboard_collector_profile AFTER INSERT ON inventory_owner FOR EACH ROW EXECUTE FUNCTION onboard_collector_profile();

-- TRIGGER: collector_profile queue_invite_record

CREATE TRIGGER queue_invite_record AFTER UPDATE OF display_name ON collector_profile FOR EACH ROW WHEN ((old.display_name IS DISTINCT FROM new.display_name)) EXECUTE FUNCTION queue_invite_record();

-- TRIGGER: invite_link queue_invite_record

CREATE TRIGGER queue_invite_record AFTER INSERT OR DELETE OR UPDATE OF token_hash ON invite_link FOR EACH ROW EXECUTE FUNCTION queue_invite_record();

-- TRIGGER: loan round_in_thread_pair

CREATE CONSTRAINT TRIGGER round_in_thread_pair AFTER INSERT ON loan DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION round_in_thread_pair('lender_id', 'borrower_id');

-- TRIGGER: trade round_in_thread_pair

CREATE CONSTRAINT TRIGGER round_in_thread_pair AFTER INSERT ON trade DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION round_in_thread_pair('proposer_id', 'recipient_id');

-- TRIGGER: loan thread_immutable

CREATE TRIGGER thread_immutable BEFORE UPDATE OF thread_id, thread_kind, lender_id, borrower_id ON loan FOR EACH ROW EXECUTE FUNCTION thread_immutable('lender_id', 'borrower_id');

-- TRIGGER: thread thread_immutable

CREATE TRIGGER thread_immutable BEFORE UPDATE OF id, kind, user_low, user_high ON thread FOR EACH ROW EXECUTE FUNCTION thread_immutable('user_low', 'user_high');

-- TRIGGER: trade thread_immutable

CREATE TRIGGER thread_immutable BEFORE UPDATE OF thread_id, thread_kind, proposer_id, recipient_id ON trade FOR EACH ROW EXECUTE FUNCTION thread_immutable('proposer_id', 'recipient_id');

-- TRIGGER: trade_line trade_line_promise_guard

CREATE CONSTRAINT TRIGGER trade_line_promise_guard AFTER INSERT OR UPDATE OF quantity, edition_id, side ON trade_line DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION trade_line_promise_guard();

-- TRIGGER: collector_profile trade_names_follow_profile

CREATE TRIGGER trade_names_follow_profile AFTER UPDATE OF display_name ON collector_profile FOR EACH ROW WHEN ((old.display_name IS DISTINCT FROM new.display_name)) EXECUTE FUNCTION trade_names_follow_profile();

-- TRIGGER: trade trade_promise_guard

CREATE CONSTRAINT TRIGGER trade_promise_guard AFTER INSERT OR UPDATE OF state, proposer_swap_at, recipient_swap_at, proposer_id, recipient_id ON trade DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION trade_promise_guard();

-- operations_state keeps its single row (migration 019).
INSERT INTO operations_state(singleton) VALUES(true);
