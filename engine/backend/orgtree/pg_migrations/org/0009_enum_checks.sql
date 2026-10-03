-- Closed value sets of current org writers. NULL preserves legacy misfits in extra.
-- 3.2.0 is unreleased; populated dev databases must be re-converted (0007).
-- Validated CHECKs only: no data-moving step; base generated DDL stays unchanged.

ALTER TABLE orgtree.org_settings ADD CONSTRAINT org_settings_permission_mode_enum
  CHECK ("permission_mode" IN ('plan', 'default', 'acceptEdits', 'bypassPermissions'));
ALTER TABLE orgtree.org_settings ADD CONSTRAINT org_settings_default_visibility_enum
  CHECK ("default_visibility" IN ('self', 'team', 'subtree', 'full'));
ALTER TABLE orgtree.org_settings ADD CONSTRAINT org_settings_default_effort_enum
  CHECK ("default_effort" IN ('low', 'medium', 'high', 'xhigh', 'max', ''));
ALTER TABLE orgtree.org_settings ADD CONSTRAINT org_settings_fable_limit_policy_enum
  CHECK ("fable_limit_policy" IN ('halt', 'opus', 'dissolve'));
ALTER TABLE orgtree.org_settings ADD CONSTRAINT org_settings_fable_filter_policy_enum
  CHECK ("fable_filter_policy" IN ('halt', 'opus', 'auto-autopsy'));
ALTER TABLE orgtree.agents ADD CONSTRAINT agents_state_enum
  CHECK ("state" IN ('live', 'archived', 'unrecoverable', 'deleted'));
ALTER TABLE orgtree.agents ADD CONSTRAINT agents_bearer_state_enum
  CHECK ("bearer_state" IN ('knowledge', 'preserving', 'lost'));
ALTER TABLE orgtree.agents ADD CONSTRAINT agents_scope_permission_mode_enum
  CHECK ("scope_permission_mode" IN ('plan', 'default', 'acceptEdits', 'bypassPermissions'));
ALTER TABLE orgtree.agents ADD CONSTRAINT agents_scope_org_visibility_enum
  CHECK ("scope_org_visibility" IN ('self', 'team', 'subtree', 'full'));
ALTER TABLE orgtree.agents ADD CONSTRAINT agents_scope_effort_enum
  CHECK ("scope_effort" IN ('low', 'medium', 'high', 'xhigh', 'max', ''));
ALTER TABLE orgtree.agents ADD CONSTRAINT agents_last_status_status_enum
  CHECK ("last_status_status" IN ('working', 'blocked', 'idle'));
ALTER TABLE orgtree.agents ADD CONSTRAINT agents_prev_status_status_enum
  CHECK ("prev_status_status" IN ('working', 'blocked', 'idle'));
ALTER TABLE orgtree.agent_dir_grants ADD CONSTRAINT agent_dir_grants_mode_enum
  CHECK ("mode" IN ('rw', 'ro'));
ALTER TABLE orgtree.work_items ADD CONSTRAINT work_items_kind_enum
  CHECK ("kind" IN ('code', 'non-code'));
ALTER TABLE orgtree.work_items ADD CONSTRAINT work_items_status_enum
  CHECK ("status" IN ('backlogged', 'open', 'in_progress', 'blocked', 'review', 'approved', 'deploy_ready', 'done', 'superseded', 'dropped'));
ALTER TABLE orgtree.work_item_acceptance ADD CONSTRAINT work_item_acceptance_checked_classification_enum
  CHECK ("checked_classification" IN ('met', 'not_exercised', 'environment_limited', 'known_negative'));
ALTER TABLE orgtree.work_item_acceptance ADD CONSTRAINT work_item_acceptance_checked_execution_enum
  CHECK ("checked_execution" IN ('independent', 'owner_report', 'source_inspection'));
ALTER TABLE orgtree.work_item_acceptance ADD CONSTRAINT work_item_acceptance_checked_result_enum
  CHECK ("checked_result" IN ('passed', 'expected_negative', 'failed', 'crashed', 'not_executed'));
ALTER TABLE orgtree.work_item_acceptance_checks ADD CONSTRAINT work_item_acceptance_checks_classification_enum
  CHECK ("classification" IN ('met', 'not_exercised', 'environment_limited', 'known_negative'));
ALTER TABLE orgtree.work_item_acceptance_checks ADD CONSTRAINT work_item_acceptance_checks_execution_enum
  CHECK ("execution" IN ('independent', 'owner_report', 'source_inspection'));
ALTER TABLE orgtree.work_item_acceptance_checks ADD CONSTRAINT work_item_acceptance_checks_result_enum
  CHECK ("result" IN ('passed', 'expected_negative', 'failed', 'crashed', 'not_executed'));
ALTER TABLE orgtree.work_item_evidence ADD CONSTRAINT work_item_evidence_kind_enum
  CHECK ("kind" IN ('note', 'link', 'file', 'commit', 'log'));
ALTER TABLE orgtree.work_item_evidence ADD CONSTRAINT work_item_evidence_execution_enum
  CHECK ("execution" IN ('independent', 'owner_report', 'source_inspection'));
ALTER TABLE orgtree.work_item_evidence ADD CONSTRAINT work_item_evidence_classification_enum
  CHECK ("classification" IN ('met', 'not_exercised', 'environment_limited', 'known_negative'));
ALTER TABLE orgtree.work_item_evidence ADD CONSTRAINT work_item_evidence_result_enum
  CHECK ("result" IN ('passed', 'expected_negative', 'failed', 'crashed', 'not_executed'));
ALTER TABLE orgtree.work_item_review_seat_requests ADD CONSTRAINT work_item_review_seat_requests_state_enum
  CHECK ("state" IN ('pending', 'granted', 'withdrawn', 'declined'));
ALTER TABLE orgtree.work_item_history ADD CONSTRAINT work_item_history_status_enum
  CHECK ("status" IN ('backlogged', 'open', 'in_progress', 'blocked', 'review', 'approved', 'deploy_ready', 'done', 'superseded', 'dropped'));
ALTER TABLE orgtree.work_item_history ADD CONSTRAINT work_item_history_status_from_enum
  CHECK ("status_from" IN ('backlogged', 'open', 'in_progress', 'blocked', 'review', 'approved', 'deploy_ready', 'done', 'superseded', 'dropped'));
ALTER TABLE orgtree.work_item_history ADD CONSTRAINT work_item_history_status_to_enum
  CHECK ("status_to" IN ('backlogged', 'open', 'in_progress', 'blocked', 'review', 'approved', 'deploy_ready', 'done', 'superseded', 'dropped'));
ALTER TABLE orgtree.work_item_history ADD CONSTRAINT work_item_history_stage_enum
  CHECK ("stage" IN ('implemented', 'committed', 'pushed', 'deployed', 'in_build'));
ALTER TABLE orgtree.work_item_history ADD CONSTRAINT work_item_history_decision_enum
  CHECK ("decision" IN ('approve', 'changes', 'approve_stage'));
ALTER TABLE orgtree.work_item_history ADD CONSTRAINT work_item_history_disposition_enum
  CHECK ("disposition" IN ('open', 'fixed', 'rejected', 'deferred', 'duplicate'));
ALTER TABLE orgtree.work_item_history ADD CONSTRAINT work_item_history_scope_enum
  CHECK ("scope" IN ('item', 'named'));
ALTER TABLE orgtree.work_item_scope ADD CONSTRAINT work_item_scope_kind_enum
  CHECK ("kind" IN ('objective', 'acceptance', 'decision'));
ALTER TABLE orgtree.work_item_scope ADD CONSTRAINT work_item_scope_mode_enum
  CHECK ("mode" IN ('append', 'replace'));
ALTER TABLE orgtree.work_item_artifacts ADD CONSTRAINT work_item_artifacts_scope_enum
  CHECK ("scope" IN ('item', 'named'));
ALTER TABLE orgtree.work_item_findings ADD CONSTRAINT work_item_findings_disposition_enum
  CHECK ("disposition" IN ('open', 'fixed', 'rejected', 'deferred', 'duplicate'));
ALTER TABLE orgtree.work_item_finding_decisions ADD CONSTRAINT work_item_finding_decisions_disposition_enum
  CHECK ("disposition" IN ('open', 'fixed', 'rejected', 'deferred', 'duplicate'));
ALTER TABLE orgtree.asks ADD CONSTRAINT asks_kind_enum
  CHECK ("kind" IN ('question'));
ALTER TABLE orgtree.asks ADD CONSTRAINT asks_status_enum
  CHECK ("status" IN ('open', 'answered', 'dismissed', 'moot', 'withdrawn'));
ALTER TABLE orgtree.credit_requests ADD CONSTRAINT credit_requests_status_enum
  CHECK ("status" IN ('pending', 'answered', 'denied', 'dismissed', 'moot', 'withdrawn'));
ALTER TABLE orgtree.scope_requests ADD CONSTRAINT scope_requests_status_enum
  CHECK ("status" IN ('pending', 'answered', 'moot', 'withdrawn'));
ALTER TABLE orgtree.scope_request_items ADD CONSTRAINT scope_request_items_kind_enum
  CHECK ("kind" IN ('dir', 'tool', 'mcp', 'permission_mode'));
ALTER TABLE orgtree.scope_request_items ADD CONSTRAINT scope_request_items_mode_enum
  CHECK ("mode" IN ('rw', 'ro', 'plan', 'default', 'acceptEdits', 'bypassPermissions'));
ALTER TABLE orgtree.scope_request_items ADD CONSTRAINT scope_request_items_decision_enum
  CHECK ("decision" IN ('approve', 'deny', 'skip', 'approve (clamped — not in effect)', 'approve (partial)'));
ALTER TABLE orgtree.scope_request_items ADD CONSTRAINT scope_request_items_tool_enum
  CHECK ("tool" IN ('bash', 'edit', 'web', 'subagents'));
ALTER TABLE orgtree.watchdogs ADD CONSTRAINT watchdogs_kind_enum
  CHECK ("kind" IN ('file', 'command', 'process', 'stream', 'activity'));
ALTER TABLE orgtree.watchdogs ADD CONSTRAINT watchdogs_state_enum
  CHECK ("state" IN ('armed', 'paused'));
ALTER TABLE orgtree.watchdogs ADD CONSTRAINT watchdogs_shell_enum
  CHECK ("shell" IN ('native', 'bash'));
ALTER TABLE orgtree.watchdogs ADD CONSTRAINT watchdogs_fire_mode_enum
  CHECK ("fire_mode" IN ('event', 'silence'));
ALTER TABLE orgtree.watchdog_tombs ADD CONSTRAINT watchdog_tombs_kind_enum
  CHECK ("kind" IN ('file', 'command', 'process', 'stream', 'activity'));
ALTER TABLE orgtree.watchdog_tombs ADD CONSTRAINT watchdog_tombs_state_enum
  CHECK ("state" IN ('superseded'));
ALTER TABLE orgtree.watchdog_tombs ADD CONSTRAINT watchdog_tombs_fire_mode_enum
  CHECK ("fire_mode" IN ('event', 'silence'));
ALTER TABLE orgtree.reservations ADD CONSTRAINT reservations_state_enum
  CHECK ("state" IN ('held', 'released', 'recovered', 'stale', 'landed'));
ALTER TABLE orgtree.documents ADD CONSTRAINT documents_format_enum
  CHECK ("format" IN ('markdown', 'html'));
ALTER TABLE orgtree.org_inbox ADD CONSTRAINT org_inbox_dir_enum
  CHECK ("dir" IN ('in', 'out'));
ALTER TABLE orgtree.user_inbox ADD CONSTRAINT user_inbox_kind_enum
  CHECK ("kind" IN ('message', 'question', 'request', 'decision', 'status', 'notice', 'watchdog'));
ALTER TABLE orgtree.user_outbox ADD CONSTRAINT user_outbox_kind_enum
  CHECK ("kind" IN ('message', 'question', 'request', 'decision', 'status', 'notice', 'watchdog'));
ALTER TABLE orgtree.user_outbox ADD CONSTRAINT user_outbox_seq_origin_enum
  CHECK ("seq_origin" IN ('deposit', 'migration_unproven', 'unresolved_mailbox'));
ALTER TABLE orgtree.user_mail_log ADD CONSTRAINT user_mail_log_kind_enum
  CHECK ("kind" IN ('message', 'question', 'request', 'decision', 'status', 'notice', 'watchdog'));
ALTER TABLE orgtree.op_receipts ADD CONSTRAINT op_receipts_cls_enum
  CHECK ("cls" IN ('transaction', 'transaction+post', 'pre_transaction', 'unrolled_side_effect', 'none'));
ALTER TABLE orgtree.op_receipts ADD CONSTRAINT op_receipts_outcome_enum
  CHECK ("outcome" IN ('applied', 'fenced'));
ALTER TABLE orgtree.org_dirs ADD CONSTRAINT org_dirs_mode_enum
  CHECK ("mode" IN ('rw', 'ro'));
ALTER TABLE orgtree.mail ADD CONSTRAINT mail_kind_enum
  CHECK ("kind" IN ('message', 'question', 'request', 'decision', 'status', 'notice', 'watchdog'));
ALTER TABLE orgtree.mail ADD CONSTRAINT mail_seq_origin_enum
  CHECK ("seq_origin" IN ('deposit', 'migration_unproven', 'unresolved_mailbox'));
ALTER TABLE orgtree.delivery_batches ADD CONSTRAINT delivery_batches_via_enum
  CHECK ("via" IN ('turn', 'steer'));
ALTER TABLE orgtree.delivery_batches ADD CONSTRAINT delivery_batches_mode_enum
  CHECK ("mode" IN ('turn', 'steer', 'manual_fetch'));
ALTER TABLE orgtree.mail_log ADD CONSTRAINT mail_log_kind_enum
  CHECK ("kind" IN ('message', 'question', 'request', 'decision', 'status', 'notice', 'watchdog'));
ALTER TABLE orgtree.mail_log ADD CONSTRAINT mail_log_seq_origin_enum
  CHECK ("seq_origin" IN ('deposit', 'migration_unproven', 'unresolved_mailbox'));
ALTER TABLE orgtree.steer_records ADD CONSTRAINT steer_records_level_enum
  CHECK ("level" IN ('accepted', 'handoff', 'recorded'));
ALTER TABLE orgtree.work_scope_log ADD CONSTRAINT work_scope_log_kind_enum
  CHECK ("kind" IN ('objective', 'acceptance', 'decision'));
ALTER TABLE orgtree.work_scope_log ADD CONSTRAINT work_scope_log_mode_enum
  CHECK ("mode" IN ('append', 'replace'));
ALTER TABLE orgtree.mail_transitions ADD CONSTRAINT mail_transitions_outcome_enum
  CHECK ("outcome" IN ('reclaimed', 'confirmed'));
ALTER TABLE orgtree.steer_attempts ADD CONSTRAINT steer_attempts_resolved_enum
  CHECK ("resolved" IN ('unconfirmable', 'delivered-elsewhere', 'superseded'));
ALTER TABLE orgtree.org_doc_migrations ADD CONSTRAINT org_doc_migrations_mode_enum
  CHECK ("mode" IN ('inspect'));
ALTER TABLE orgtree.org_accounts ADD CONSTRAINT org_accounts_provider_enum
  CHECK ("provider" IN ('claude', 'openai', 'google'));
ALTER TABLE orgtree.org_accounts ADD CONSTRAINT org_accounts_credential_kind_enum
  CHECK ("credential_kind" IN ('imported', 'managed', 'token', 'apikey'));
ALTER TABLE orgtree.org_accounts ADD CONSTRAINT org_accounts_auth_enum
  CHECK ("auth" IN ('authenticated', 'unauthenticated', 'unobserved'));
ALTER TABLE orgtree.org_accounts ADD CONSTRAINT org_accounts_mode_enum
  CHECK ("mode" IN ('subscription', 'apikey'));
ALTER TABLE orgtree.org_account_marks ADD CONSTRAINT org_account_marks_provenance_enum
  CHECK ("provenance" IN ('observed', 'inferred'));
ALTER TABLE orgtree.org_account_mark_audit ADD CONSTRAINT org_account_mark_audit_source_enum
  CHECK ("source" IN ('registry'));
