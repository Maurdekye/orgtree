-- Docket history: exact source records, explicit restricted current pointers.
-- Prerelease databases must be converted fresh, never silently backfilled.
DO $guard$
BEGIN
 IF EXISTS (SELECT 1 FROM orgtree.work_items) THEN
  RAISE EXCEPTION 'converted before 0010: re-convert it from its legacy data';
 END IF;
END
$guard$;
CREATE TABLE orgtree.work_item_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id bigint NOT NULL REFERENCES orgtree.work_items(id) ON DELETE CASCADE,
  seq bigint NOT NULL CHECK(seq>0),
  source text NOT NULL CHECK(source IN ('history','evidence','scope','candidate_verdicts','review_packets','dismissals','scope_archive','quick_staff_receipts')),
  kind text NOT NULL CHECK(kind IN ('history','evidence','scope','decision','verdict','review_packet','dismissal','quick_staff_receipt')),
  at timestamptz,
  by_node text,
  by_generation bigint,
  by_born text,
  content text,
  status_change boolean NOT NULL,
  original_at json,
  original_scope_seq json,
  "history_is" char(1),
  "history_at" timestamptz,
  "history_at_text" text,
  "history_by" json,
  "history_op" text,
  "history_kind" text,
  "history_from" json,
  "history_from_null" boolean,
  "history_to" json,
  "history_to_null" boolean,
  "history_done" json,
  "history_next" json,
  "history_changes" json,
  "history_now" json,
  "history_why" text,
  "history_note" text,
  "history_note_null" boolean,
  "history_reason" text,
  "history_status" text,
  "history_status_from" text,
  "history_status_to" text,
  "history_stage" text,
  "history_reviewer" text,
  "history_candidate" text,
  "history_decision" text,
  "history_disposition" text,
  "history_finding" text,
  "history_artifact" text,
  "history_name" text,
  "history_scope" text,
  "history_via" text,
  "history_evidence_gap" text,
  "history_answer" text,
  "history_scope_seq" bigint,
  "history_batch" bigint,
  "history_index" bigint,
  "history_set_rev" bigint,
  "history_supersedes" bigint,
  "history_count" bigint,
  "history_answered_request" bigint,
  "history_answered_request_null" boolean,
  "history_already_seated" boolean,
  "history_after_completion" boolean,
  "history_atomic_completion" boolean,
  "history_review_in_flight" boolean,
  "history_verified" boolean,
  "history_verified_null" boolean,
  "history_accepted_at" timestamptz,
  "history_accepted_at_text" text,
  "history_first_at" timestamptz,
  "history_first_at_text" text,
  "history_last_at" timestamptz,
  "history_last_at_text" text,
  "history_raised_at" timestamptz,
  "history_raised_at_text" text,
  "history_kinds" json,
  "history_indexes" json,
  "history_touched" json,
  "history_requests" json,
  "history_done_was" json,
  "history_next_was" json,
  "history_next_actor" json,
  "history_raised_by" json,
  "history_review_packet_was" json,
  "history_review_packet_was_null" boolean,
  "history_accepted_was" json,
  "history_accepted_was_null" boolean,
  "history_superseded_by_was" json,
  "history_superseded_by_was_null" boolean,
  "history_dropped_reason_was" json,
  "history_dropped_reason_was_null" boolean,
  "history_candidate_verdict_was" json,
  "history_candidate_verdict_was_null" boolean,
  "evidence_is" char(1),
  "evidence_at" timestamptz,
  "evidence_at_text" text,
  "evidence_by_is" char(1),
  "evidence_by_node" text,
  "evidence_by_generation" bigint,
  "evidence_kind" text,
  "evidence_ref" text,
  "evidence_note" text,
  "evidence_execution" text,
  "evidence_execution_means" text,
  "evidence_receipt" json,
  "evidence_classification" text,
  "evidence_artifact" text,
  "evidence_runner" text,
  "evidence_result" text,
  "evidence_classification_means" text,
  "scope_is" char(1),
  "scope_seq" bigint,
  "scope_at" timestamptz,
  "scope_at_text" text,
  "scope_by_is" char(1),
  "scope_by_node" text,
  "scope_by_generation" bigint,
  "scope_kind" text,
  "scope_before" text,
  "scope_after" text,
  "scope_mode" text,
  "scope_supersedes" bigint,
  "scope_supersedes_null" boolean,
  "scope_superseded_by" bigint,
  "scope_superseded_by_null" boolean,
  "scope_text" text,
  "candidate_verdicts_is" char(1),
  "candidate_verdicts_at" timestamptz,
  "candidate_verdicts_at_text" text,
  "candidate_verdicts_by_is" char(1),
  "candidate_verdicts_by_node" text,
  "candidate_verdicts_by_generation" bigint,
  "candidate_verdicts_by_born" text,
  "candidate_verdicts_candidate" text,
  "candidate_verdicts_decision" text,
  "candidate_verdicts_evidence" json,
  "candidate_verdicts_note" text,
  "candidate_verdicts_note_null" boolean,
  "candidate_verdicts_next_actor_is" char(1),
  "candidate_verdicts_next_actor_node" text,
  "candidate_verdicts_next_actor_generation" bigint,
  "candidate_verdicts_next_actor_born" text,
  "review_packets_is" char(1),
  "review_packets_at" timestamptz,
  "review_packets_at_text" text,
  "review_packets_by_is" char(1),
  "review_packets_by_node" text,
  "review_packets_by_generation" bigint,
  "review_packets_by_born" text,
  "review_packets_candidate" text,
  "review_packets_candidate_null" boolean,
  "review_packets_base" text,
  "review_packets_base_null" boolean,
  "review_packets_note" text,
  "review_packets_evidence" json,
  "review_packets_next_actor_is" char(1),
  "review_packets_next_actor_node" text,
  "review_packets_next_actor_generation" bigint,
  "review_packets_next_actor_born" text,
  "dismissals_is" char(1),
  "dismissals_at" timestamptz,
  "dismissals_at_text" text,
  "dismissals_by" text,
  "dismissals_set_rev" bigint,
  "dismissals_reason" text,
  "scope_archive_is" char(1),
  "scope_archive_seq" bigint,
  "scope_archive_at" timestamptz,
  "scope_archive_at_text" text,
  "scope_archive_by_is" char(1),
  "scope_archive_by_node" text,
  "scope_archive_by_generation" bigint,
  "scope_archive_kind" text,
  "scope_archive_before" text,
  "scope_archive_after" text,
  "scope_archive_mode" text,
  "scope_archive_supersedes" bigint,
  "scope_archive_supersedes_null" boolean,
  "scope_archive_superseded_by" bigint,
  "scope_archive_superseded_by_null" boolean,
  "scope_archive_text" text,
  "quick_staff_receipts" json,
  "extra" json
);

CREATE UNIQUE INDEX work_item_events_seq ON orgtree.work_item_events(item_id,seq);

CREATE INDEX work_item_events_source ON orgtree.work_item_events(item_id,source,seq);

CREATE INDEX work_item_events_status ON orgtree.work_item_events(item_id,seq DESC) WHERE source='history' AND status_change;
ALTER TABLE orgtree.work_items ALTER COLUMN docket_scope_meta DROP EXPRESSION;
ALTER TABLE orgtree.work_items ADD COLUMN archive_seq bigint;
CREATE UNIQUE INDEX work_items_archive_seq ON orgtree.work_items(archive_seq) WHERE archive_seq IS NOT NULL;
ALTER TABLE orgtree.work_items ADD COLUMN history_events_is char(1) CHECK(history_events_is IN ('n','l','x'));
ALTER TABLE orgtree.work_items ADD COLUMN evidence_events_is char(1) CHECK(evidence_events_is IN ('n','l','x'));
ALTER TABLE orgtree.work_items ADD COLUMN scope_events_is char(1) CHECK(scope_events_is IN ('n','l','x'));
ALTER TABLE orgtree.work_items ADD COLUMN candidate_verdicts_events_is char(1) CHECK(candidate_verdicts_events_is IN ('n','l','x'));
ALTER TABLE orgtree.work_items ADD COLUMN review_packets_events_is char(1) CHECK(review_packets_events_is IN ('n','l','x'));
ALTER TABLE orgtree.work_items ADD COLUMN dismissals_events_is char(1) CHECK(dismissals_events_is IN ('n','l','x'));
ALTER TABLE orgtree.work_items ADD COLUMN scope_archive_events_is char(1) CHECK(scope_archive_events_is IN ('n','l','x'));
ALTER TABLE orgtree.work_items ADD COLUMN quick_staff_receipts_events_is char(1) CHECK(quick_staff_receipts_events_is IN ('n','l','x'));
ALTER TABLE orgtree.work_items
 ADD COLUMN current_verdict_event_id bigint,
 ADD COLUMN current_verdict_event_id_is char(1) CHECK(current_verdict_event_id_is IN ('n','v')),
 ADD COLUMN current_verdict_event_id_kind text GENERATED ALWAYS AS ('verdict'::text) STORED,
 ADD CONSTRAINT current_verdict_event_id_presence CHECK ((current_verdict_event_id IS NOT NULL)=(current_verdict_event_id_is IS NOT DISTINCT FROM 'v'));
ALTER TABLE orgtree.work_items
 ADD COLUMN current_review_packet_event_id bigint,
 ADD COLUMN current_review_packet_event_id_is char(1) CHECK(current_review_packet_event_id_is IN ('n','v')),
 ADD COLUMN current_review_packet_event_id_kind text GENERATED ALWAYS AS ('review_packet'::text) STORED,
 ADD CONSTRAINT current_review_packet_event_id_presence CHECK ((current_review_packet_event_id IS NOT NULL)=(current_review_packet_event_id_is IS NOT DISTINCT FROM 'v'));
ALTER TABLE orgtree.work_item_events ADD CONSTRAINT work_item_events_pointer_key UNIQUE(id,item_id,kind);
ALTER TABLE orgtree.work_item_events ADD CONSTRAINT work_item_events_source_kind CHECK(
 (source='history' AND kind='history') OR (source='evidence' AND kind='evidence') OR
 (source IN ('scope','scope_archive') AND kind IN ('scope','decision')) OR
 (source='candidate_verdicts' AND kind='verdict') OR (source='review_packets' AND kind='review_packet') OR
 (source='dismissals' AND kind='dismissal') OR (source='quick_staff_receipts' AND kind='quick_staff_receipt'));
ALTER TABLE orgtree.work_items ADD CONSTRAINT current_verdict_event_id_fk
 FOREIGN KEY(current_verdict_event_id,id,current_verdict_event_id_kind) REFERENCES orgtree.work_item_events(id,item_id,kind)
 ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE orgtree.work_items ADD CONSTRAINT current_review_packet_event_id_fk
 FOREIGN KEY(current_review_packet_event_id,id,current_review_packet_event_id_kind) REFERENCES orgtree.work_item_events(id,item_id,kind)
 ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
DROP TABLE orgtree.work_item_history;
ALTER TABLE orgtree.work_items DROP COLUMN history_is;
DROP TABLE orgtree.work_item_evidence;
ALTER TABLE orgtree.work_items DROP COLUMN evidence_is;
DROP TABLE orgtree.work_item_scope;
ALTER TABLE orgtree.work_items DROP COLUMN scope_is;
DROP TABLE orgtree.work_item_dismissals;
ALTER TABLE orgtree.work_items DROP COLUMN dismissals_is;
ALTER TABLE orgtree.work_items DROP COLUMN candidate_verdict;
ALTER TABLE orgtree.work_items DROP COLUMN candidate_verdict_null;
ALTER TABLE orgtree.work_items DROP COLUMN candidate_verdicts;
ALTER TABLE orgtree.work_items DROP COLUMN review_packet;
ALTER TABLE orgtree.work_items DROP COLUMN review_packet_null;
ALTER TABLE orgtree.work_items DROP COLUMN review_packets;
ALTER TABLE orgtree.work_items DROP COLUMN quick_staff_receipts;
DO $triggers$
DECLARE counter text;
BEGIN
 FOREACH counter IN ARRAY ARRAY['view_rev','docket_rev'] LOOP
  EXECUTE format('CREATE TRIGGER %I AFTER INSERT ON orgtree.work_item_events REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION orgtree.foreground_accumulate(%L,%L)', 'events_'||counter||'_insert',counter,'flag');
  EXECUTE format('CREATE TRIGGER %I AFTER UPDATE ON orgtree.work_item_events REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION orgtree.foreground_accumulate(%L,%L)', 'events_'||counter||'_update',counter,'flag');
  EXECUTE format('CREATE TRIGGER %I AFTER DELETE ON orgtree.work_item_events REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION orgtree.foreground_accumulate(%L,%L)', 'events_'||counter||'_delete',counter,'flag');
  EXECUTE format('CREATE CONSTRAINT TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON orgtree.work_item_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION orgtree.foreground_flush(%L)', 'events_'||counter||'_flush',counter);
 END LOOP;
END
$triggers$;

CREATE TRIGGER foreground_defer BEFORE INSERT OR UPDATE OR DELETE
 ON orgtree.work_item_events FOR EACH STATEMENT EXECUTE FUNCTION orgtree.foreground_defer();
