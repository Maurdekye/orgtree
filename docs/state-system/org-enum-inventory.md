# Org-database enum inventory

Migration `0009_enum_checks.sql` adds validated CHECKs only. No rows are moved; unreleased populated dev databases must be re-converted under migration 0007. The generated base migrations and mapper DDL stay byte-identical.

Each declared text enum has `Field.values`. An invalid legacy member or shape leaves the column NULL and keeps the original value in `extra`; decode merges it back exactly. The conversion result names the org, table, placement keys and field without printing the private value. Missing and explicit null are distinct and are not reported as invalid enum members.

## Current columns and writer sources

Sources below are in `engine/backend/orgtree/`. Constants and function names are used so rebases do not turn line numbers into the wrong reference.

| Column | Allowed values | Writer / reader source |
| --- | --- | --- |
| `org_settings.permission_mode` | `'plan'`, `'default'`, `'acceptEdits'`, `'bypassPermissions'` | ledger.PM_LEVELS; Org.set_scope / Org.create |
| `org_settings.default_visibility` | `'self'`, `'team'`, `'subtree'`, `'full'` | ledger.VIS_LEVELS; Org.set_scope |
| `org_settings.default_effort` | `'low'`, `'medium'`, `'high'`, `'xhigh'`, `'max'`, `''` | ledger.EFFORTS; Org.set_scope (empty string clears it) |
| `org_settings.fable_limit_policy` | `'halt'`, `'opus'`, `'dissolve'` | ledger.Org.create / fable_limit_hit / fable_filter_hit / constructor normalization |
| `org_settings.fable_filter_policy` | `'halt'`, `'opus'`, `'auto-autopsy'` | ledger.Org.create / fable_limit_hit / fable_filter_hit / constructor normalization |
| `agents.state` | `'live'`, `'archived'`, `'unrecoverable'`, `'deleted'` | ledger.Org._new_node / retire / mark_unrecoverable; design §2.2 includes deleted |
| `agents.bearer_state` | `'knowledge'`, `'preserving'`, `'lost'` | schema.BearerState; ledger archival / phantom lineage repair |
| `agents.scope_permission_mode` | `'plan'`, `'default'`, `'acceptEdits'`, `'bypassPermissions'` | ledger.PM_LEVELS; Org.set_scope / Org.create |
| `agents.scope_org_visibility` | `'self'`, `'team'`, `'subtree'`, `'full'` | ledger.VIS_LEVELS; Org.set_scope |
| `agents.scope_effort` | `'low'`, `'medium'`, `'high'`, `'xhigh'`, `'max'`, `''` | ledger.EFFORTS; Org.set_scope (empty string clears it) |
| `agents.last_status_status` | `'working'`, `'blocked'`, `'idle'` | api.orgtree_status dispatch (done stores idle); ledger.Org._new_node |
| `agents.prev_status_status` | `'working'`, `'blocked'`, `'idle'` | api.orgtree_status dispatch (done stores idle); ledger.Org._new_node |
| `agent_dir_grants.mode` | `'rw'`, `'ro'` | schema.DirMode; ledger._dirs / Org._clamp_dirs |
| `work_items.kind` | `'code'`, `'non-code'` | ledger.Org.WORK_STATUSES / WORK_EVIDENCE_KINDS / work_create kind validation; source status copied to history |
| `work_items.status` | `'backlogged'`, `'open'`, `'in_progress'`, `'blocked'`, `'review'`, `'approved'`, `'deploy_ready'`, `'done'`, `'superseded'`, `'dropped'` | ledger.Org.WORK_STATUSES / WORK_EVIDENCE_KINDS / work_create kind validation; source status copied to history |
| `work_item_acceptance.checked_classification` | `'met'`, `'not_exercised'`, `'environment_limited'`, `'known_negative'` | workevidence.ACCEPTANCE_CLASSES / EXECUTION / RESULTS |
| `work_item_acceptance.checked_execution` | `'independent'`, `'owner_report'`, `'source_inspection'` | workevidence.ACCEPTANCE_CLASSES / EXECUTION / RESULTS |
| `work_item_acceptance.checked_result` | `'passed'`, `'expected_negative'`, `'failed'`, `'crashed'`, `'not_executed'` | workevidence.ACCEPTANCE_CLASSES / EXECUTION / RESULTS |
| `work_item_acceptance_checks.classification` | `'met'`, `'not_exercised'`, `'environment_limited'`, `'known_negative'` | workevidence.ACCEPTANCE_CLASSES / EXECUTION / RESULTS |
| `work_item_acceptance_checks.execution` | `'independent'`, `'owner_report'`, `'source_inspection'` | workevidence.ACCEPTANCE_CLASSES / EXECUTION / RESULTS |
| `work_item_acceptance_checks.result` | `'passed'`, `'expected_negative'`, `'failed'`, `'crashed'`, `'not_executed'` | workevidence.ACCEPTANCE_CLASSES / EXECUTION / RESULTS |
| `work_item_evidence.kind` | `'note'`, `'link'`, `'file'`, `'commit'`, `'log'` | ledger.Org.WORK_STATUSES / WORK_EVIDENCE_KINDS / work_create kind validation; source status copied to history |
| `work_item_evidence.execution` | `'independent'`, `'owner_report'`, `'source_inspection'` | workevidence.ACCEPTANCE_CLASSES / EXECUTION / RESULTS |
| `work_item_evidence.classification` | `'met'`, `'not_exercised'`, `'environment_limited'`, `'known_negative'` | workevidence.ACCEPTANCE_CLASSES / EXECUTION / RESULTS |
| `work_item_evidence.result` | `'passed'`, `'expected_negative'`, `'failed'`, `'crashed'`, `'not_executed'` | workevidence.ACCEPTANCE_CLASSES / EXECUTION / RESULTS |
| `work_item_review_seat_requests.state` | `'pending'`, `'granted'`, `'withdrawn'`, `'declined'` | ledger.Org.work_review_request / _work_record_seat / work_review_revoke |
| `work_item_history.status` | `'backlogged'`, `'open'`, `'in_progress'`, `'blocked'`, `'review'`, `'approved'`, `'deploy_ready'`, `'done'`, `'superseded'`, `'dropped'` | ledger.Org.WORK_STATUSES / WORK_EVIDENCE_KINDS / work_create kind validation; source status copied to history |
| `work_item_history.status_from` | `'backlogged'`, `'open'`, `'in_progress'`, `'blocked'`, `'review'`, `'approved'`, `'deploy_ready'`, `'done'`, `'superseded'`, `'dropped'` | ledger.Org.WORK_STATUSES / WORK_EVIDENCE_KINDS / work_create kind validation; source status copied to history |
| `work_item_history.status_to` | `'backlogged'`, `'open'`, `'in_progress'`, `'blocked'`, `'review'`, `'approved'`, `'deploy_ready'`, `'done'`, `'superseded'`, `'dropped'` | ledger.Org.WORK_STATUSES / WORK_EVIDENCE_KINDS / work_create kind validation; source status copied to history |
| `work_item_history.stage` | `'implemented'`, `'committed'`, `'pushed'`, `'deployed'`, `'in_build'` | workitems.STAGES; ledger.Org.work_claim |
| `work_item_history.decision` | `'approve'`, `'changes'`, `'approve_stage'` | ledger.Org.work_review (approve / approve_stage / changes) |
| `work_item_history.disposition` | `'open'`, `'fixed'`, `'rejected'`, `'deferred'`, `'duplicate'` | ledger.WORK_DISPOSITIONS; Org.work_finding / work_dispose |
| `work_item_history.scope` | `'item'`, `'named'` | ledger.Org.work_artifact (item / named) |
| `work_item_scope.kind` | `'objective'`, `'acceptance'`, `'decision'` | ledger.Org._work_scope_append and objective/acceptance/decision callers |
| `work_item_scope.mode` | `'append'`, `'replace'` | ledger.Org._work_scope_append and objective/acceptance/decision callers |
| `work_item_artifacts.scope` | `'item'`, `'named'` | ledger.Org.work_artifact (item / named) |
| `work_item_findings.disposition` | `'open'`, `'fixed'`, `'rejected'`, `'deferred'`, `'duplicate'` | ledger.WORK_DISPOSITIONS; Org.work_finding / work_dispose |
| `work_item_finding_decisions.disposition` | `'open'`, `'fixed'`, `'rejected'`, `'deferred'`, `'duplicate'` | ledger.WORK_DISPOSITIONS; Org.work_finding / work_dispose |
| `asks.kind` | `'question'` | ledger.Org.ask_user / request_credits / request_scope / resolve_batch / dismiss_batch / withdraw_ask; SCOPE_KINDS |
| `asks.status` | `'open'`, `'answered'`, `'dismissed'`, `'moot'`, `'withdrawn'` | ledger.Org.ask_user / request_credits / request_scope / resolve_batch / dismiss_batch / withdraw_ask; SCOPE_KINDS |
| `credit_requests.status` | `'pending'`, `'answered'`, `'denied'`, `'dismissed'`, `'moot'`, `'withdrawn'` | ledger.Org.ask_user / request_credits / request_scope / resolve_batch / dismiss_batch / withdraw_ask; SCOPE_KINDS |
| `scope_requests.status` | `'pending'`, `'answered'`, `'moot'`, `'withdrawn'` | ledger.Org.ask_user / request_credits / request_scope / resolve_batch / dismiss_batch / withdraw_ask; SCOPE_KINDS |
| `scope_request_items.kind` | `'dir'`, `'tool'`, `'mcp'`, `'permission_mode'` | ledger.Org.ask_user / request_credits / request_scope / resolve_batch / dismiss_batch / withdraw_ask; SCOPE_KINDS |
| `scope_request_items.mode` | `'rw'`, `'ro'`, `'plan'`, `'default'`, `'acceptEdits'`, `'bypassPermissions'` | ledger.Org.ask_user / request_credits / request_scope / resolve_batch / dismiss_batch / withdraw_ask; SCOPE_KINDS |
| `scope_request_items.decision` | `'approve'`, `'deny'`, `'skip'`, `'approve (clamped — not in effect)'`, `'approve (partial)'` | ledger.Org.ask_user / request_credits / request_scope / resolve_batch / dismiss_batch / withdraw_ask; SCOPE_KINDS |
| `scope_request_items.tool` | `'bash'`, `'edit'`, `'web'`, `'subagents'` | ledger.Org.ask_user / request_credits / request_scope / resolve_batch / dismiss_batch / withdraw_ask; SCOPE_KINDS |
| `watchdogs.kind` | `'file'`, `'command'`, `'process'`, `'stream'`, `'activity'` | ledger.Org.watchdog_create / watchdog_control / watchdog_fire; watchdog_config.settings |
| `watchdogs.state` | `'armed'`, `'paused'` | ledger.Org.watchdog_create / watchdog_control / watchdog_fire; watchdog_config.settings |
| `watchdogs.shell` | `'native'`, `'bash'` | ledger.Org.watchdog_create / watchdog_control / watchdog_fire; watchdog_config.settings |
| `watchdogs.fire_mode` | `'event'`, `'silence'` | ledger.Org.watchdog_create / watchdog_control / watchdog_fire; watchdog_config.settings |
| `watchdog_tombs.kind` | `'file'`, `'command'`, `'process'`, `'stream'`, `'activity'` | ledger.Org.watchdog_create / watchdog_control / watchdog_fire; watchdog_config.settings |
| `watchdog_tombs.state` | `'superseded'` | ledger.Org.watchdog_create / watchdog_control / watchdog_fire; watchdog_config.settings |
| `watchdog_tombs.fire_mode` | `'event'`, `'silence'` | ledger.Org.watchdog_create / watchdog_control / watchdog_fire; watchdog_config.settings |
| `reservations.state` | `'held'`, `'released'`, `'recovered'`, `'stale'`, `'landed'` | reservations.HELD / RELEASED / RECOVERED / STALE / LANDED |
| `documents.format` | `'markdown'`, `'html'` | ledger.Org.present / present_html; api document reader markdown default |
| `org_inbox.dir` | `'in'`, `'out'` | schema.OrgInboxEntry; ledger.Org._org_inbox_log callers |
| `user_inbox.kind` | `'message'`, `'question'`, `'request'`, `'decision'`, `'status'`, `'notice'`, `'watchdog'` | ledger._ORDINARY_OF; Org.post_mail / append_system_mail / watchdog_fire |
| `user_outbox.kind` | `'message'`, `'question'`, `'request'`, `'decision'`, `'status'`, `'notice'`, `'watchdog'` | ledger._ORDINARY_OF; Org.post_mail / append_system_mail / watchdog_fire |
| `user_outbox.seq_origin` | `'deposit'`, `'migration_unproven'`, `'unresolved_mailbox'` | ledger.Org.MAIL_SEQ_ORIGIN_* |
| `user_mail_log.kind` | `'message'`, `'question'`, `'request'`, `'decision'`, `'status'`, `'notice'`, `'watchdog'` | ledger._ORDINARY_OF; Org.post_mail / append_system_mail / watchdog_fire |
| `op_receipts.cls` | `'transaction'`, `'transaction+post'`, `'pre_transaction'`, `'unrolled_side_effect'`, `'none'` | opreceipts.TX / TX_POST / PRE / UNROLLED / NONE; api applied / fenced receipt writers |
| `op_receipts.outcome` | `'applied'`, `'fenced'` | opreceipts.TX / TX_POST / PRE / UNROLLED / NONE; api applied / fenced receipt writers |
| `org_dirs.mode` | `'rw'`, `'ro'` | schema.DirMode; ledger._dirs / Org._clamp_dirs |
| `mail.kind` | `'message'`, `'question'`, `'request'`, `'decision'`, `'status'`, `'notice'`, `'watchdog'` | ledger._ORDINARY_OF; Org.post_mail / append_system_mail / watchdog_fire |
| `mail.seq_origin` | `'deposit'`, `'migration_unproven'`, `'unresolved_mailbox'` | ledger.Org.MAIL_SEQ_ORIGIN_* |
| `delivery_batches.via` | `'turn'`, `'steer'` | supervisor._journal_drain / manual_fetch; mailruntime.CUSTODY_MANUAL_FETCH |
| `delivery_batches.mode` | `'turn'`, `'steer'`, `'manual_fetch'` | supervisor._journal_drain / manual_fetch; mailruntime.CUSTODY_MANUAL_FETCH |
| `mail_log.kind` | `'message'`, `'question'`, `'request'`, `'decision'`, `'status'`, `'notice'`, `'watchdog'` | ledger._ORDINARY_OF; Org.post_mail / append_system_mail / watchdog_fire |
| `mail_log.seq_origin` | `'deposit'`, `'migration_unproven'`, `'unresolved_mailbox'` | ledger.Org.MAIL_SEQ_ORIGIN_* |
| `steer_records.level` | `'accepted'`, `'handoff'`, `'recorded'` | supervisor.commit_steer / pop_steer / _apply_steer_record |
| `work_scope_log.kind` | `'objective'`, `'acceptance'`, `'decision'` | ledger.Org._work_scope_append and objective/acceptance/decision callers |
| `work_scope_log.mode` | `'append'`, `'replace'` | ledger.Org._work_scope_append and objective/acceptance/decision callers |
| `mail_transitions.outcome` | `'reclaimed'`, `'confirmed'` | mailruntime.reclaim_receipt / confirmation_receipt |
| `steer_attempts.resolved` | `'unconfirmable'`, `'delivered-elsewhere'`, `'superseded'` | supervisor._trim_steer_attempts / _supersede_steer_attempts (unconfirmable / delivered-elsewhere / superseded) |
| `org_doc_migrations.mode` | `'inspect'` | ledger.Org._migrate_extern_multi_holder (inspect) |
| `org_accounts.provider` | `'claude'`, `'openai'`, `'google'` | registry.PROVIDERS / CREDENTIAL_KINDS / AUTH_STATES / PROVENANCE; create mode validation; clear_mark source |
| `org_accounts.credential_kind` | `'imported'`, `'managed'`, `'token'`, `'apikey'` | registry.PROVIDERS / CREDENTIAL_KINDS / AUTH_STATES / PROVENANCE; create mode validation; clear_mark source |
| `org_accounts.auth` | `'authenticated'`, `'unauthenticated'`, `'unobserved'` | registry.PROVIDERS / CREDENTIAL_KINDS / AUTH_STATES / PROVENANCE; create mode validation; clear_mark source |
| `org_accounts.mode` | `'subscription'`, `'apikey'` | registry.PROVIDERS / CREDENTIAL_KINDS / AUTH_STATES / PROVENANCE; create mode validation; clear_mark source |
| `org_account_marks.provenance` | `'observed'`, `'inferred'` | registry.PROVIDERS / CREDENTIAL_KINDS / AUTH_STATES / PROVENANCE; create mode validation; clear_mark source |
| `org_account_mark_audit.source` | `'registry'` | registry.PROVIDERS / CREDENTIAL_KINDS / AUTH_STATES / PROVENANCE; create mode validation; clear_mark source |

81 declared enum columns.

## Landed equivalents of the design table names

- Agent state and bearer state are on `agents`; dir modes are on `agent_dir_grants` and `org_dirs`.
- Questions, credits and scope requests use separate tables. `asks.kind` is currently `question`; the design’s combined ask/credit/scope kind is not a landed column.
- Denial and approval prompts use separate agent child tables, as do work-item done and next progress. No shared kind/list column exists.
- Principals do not have the proposed role-kind columns. Mail ownership uses mailbox / delivery tables, not the proposed queued/delivering/delivered mail state or pending/delivered notice state columns.
- Restricted org accounts are covered here; shared app account specs stay unchanged. App registry enums are outside this ticket.

## Fields without a closed value set

Model/tier strings, account harness overrides, provider-reported cost sources, human relationship descriptions, finding severity, operation IDs and lifecycle/event operation labels are open values. Their writers accept arbitrary text or new event/verb names; treating their observed values as a closed set would change accepted inputs.

Legacy/future mapper columns with no current writer include `audience_requests.status` and `org_inbox.state`. No set is guessed for them. Codec container markers (`*_is`) describe shape, not engine enum values. Existing placement/framework CHECKs are retained.
