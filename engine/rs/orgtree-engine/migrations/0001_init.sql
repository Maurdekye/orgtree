-- Orgtree engine schema, version 1.
-- One database for every org; every table carries org_id where it belongs to
-- an org. Partial indexes cover only the ACTIVE subset (live agents, pending
-- mail, open asks, unarchived tickets), so history never slows a hot path.

CREATE SCHEMA IF NOT EXISTS ot;

CREATE TABLE ot.meta (
  key   text PRIMARY KEY,
  value jsonb NOT NULL
);

CREATE TABLE ot.kv (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- orgs
CREATE TABLE ot.orgs (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  uuid        uuid NOT NULL UNIQUE,
  slug        text NOT NULL CHECK (slug <> ''),
  name        text NOT NULL,
  state       text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'trashed')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  trashed_at  timestamptz,
  -- org settings exactly as the settings routes read/write them
  settings    jsonb NOT NULL DEFAULT '{}',
  killswitch  jsonb,
  -- F-06 network config: {autoconnect, hubs:[{id,address,enabled}], identity:{secret,fingerprint,slug,minted_at}}
  net         jsonb NOT NULL DEFAULT '{}',
  row_version bigint NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX orgs_slug_active ON ot.orgs (slug) WHERE state = 'active';

-- ---------------------------------------------------------------- agents
CREATE TABLE ot.agents (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id         bigint NOT NULL REFERENCES ot.orgs (id),
  name           text NOT NULL CHECK (name <> ''),
  parent_id      bigint REFERENCES ot.agents (id),
  sibling_order  double precision NOT NULL DEFAULT 0,
  state          text NOT NULL CHECK (state IN ('live', 'archived', 'unrecoverable', 'deleted')),
  title          text NOT NULL DEFAULT '',
  charter        text,
  team_charter   text,
  tier           text NOT NULL,
  account        text,
  seat           numeric(14, 2) NOT NULL DEFAULT 0,
  grant_credits  numeric(14, 2) NOT NULL DEFAULT 0,
  -- configured scope (NodeScope shape); effective scope is clamped by ancestors at read time
  scope          jsonb NOT NULL DEFAULT '{}',
  generation     integer NOT NULL DEFAULT 1,
  born           text NOT NULL,
  provider       text,
  session_id     text,
  cost_usd       numeric(16, 6) NOT NULL DEFAULT 0,
  api_cost_usd   numeric(16, 6) NOT NULL DEFAULT 0,
  cost_unknown   boolean NOT NULL DEFAULT false,
  context_window integer,
  occupancy      integer,
  occupancy_est  boolean NOT NULL DEFAULT false,
  compacted_unrun boolean NOT NULL DEFAULT false,
  last_status    jsonb,
  prev_status    jsonb,
  frozen         jsonb,
  halt           jsonb,
  pending_switch jsonb,
  pending_account jsonb,
  limit_locked   boolean NOT NULL DEFAULT false,
  last_error     text,
  last_denials   jsonb NOT NULL DEFAULT '[]',
  last_approvals jsonb,
  inflight_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  archived_at    timestamptz,
  scratch_dir    text,
  -- seldom-used facts that need no column (predecessor info, import origin, ...)
  extra          jsonb NOT NULL DEFAULT '{}',
  row_version    bigint NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX agents_name ON ot.agents (org_id, name) WHERE state <> 'deleted';
CREATE INDEX agents_live ON ot.agents (org_id, id) WHERE state = 'live';
CREATE INDEX agents_children ON ot.agents (parent_id) WHERE state = 'live';
CREATE INDEX agents_retired ON ot.agents (org_id, parent_id, id) WHERE state IN ('archived', 'unrecoverable');
CREATE INDEX agents_inflight ON ot.agents (id) WHERE inflight_at IS NOT NULL;
CREATE INDEX agents_frozen ON ot.agents (org_id) WHERE frozen IS NOT NULL AND state = 'live';

-- one row per provider session an agent has had (cheap compact and
-- cross-provider switches start a new one)
CREATE TABLE ot.agent_sessions (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agent_id    bigint NOT NULL REFERENCES ot.agents (id),
  generation  integer NOT NULL,
  provider    text NOT NULL,
  session_id  text NOT NULL,
  started_at  timestamptz NOT NULL DEFAULT now(),
  ended_at    timestamptz,
  end_reason  text,
  transcript_file text
);
CREATE INDEX agent_sessions_agent ON ot.agent_sessions (agent_id, id DESC);

-- ---------------------------------------------------------------- turns
CREATE TABLE ot.turns (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agent_id      bigint NOT NULL REFERENCES ot.agents (id),
  started_at    timestamptz NOT NULL,
  ended_at      timestamptz,
  cost_usd      numeric(16, 6),
  cost_source   text,
  estimated     boolean NOT NULL DEFAULT false,
  toks          bigint,
  input_tokens  bigint,
  cache_read    bigint,
  cache_write   bigint,
  cache_ttl_s   integer,
  ms            bigint,
  denials       integer NOT NULL DEFAULT 0,
  approvals     integer,
  killed        boolean NOT NULL DEFAULT false,
  error         text,
  account       text,
  api_key       boolean NOT NULL DEFAULT false,
  model         text
);
CREATE INDEX turns_agent ON ot.turns (agent_id, id DESC);

-- ---------------------------------------------------------------- conversation
-- Rows already in the shape the desk renders (ChatMessage). seq orders rows;
-- ver is bumped on insert AND update so `after` reads are incremental.
CREATE TABLE ot.convo (
  agent_id  bigint NOT NULL REFERENCES ot.agents (id),
  seq       bigint NOT NULL,
  ver       bigint NOT NULL,
  at        timestamptz NOT NULL DEFAULT now(),
  body      jsonb NOT NULL,
  PRIMARY KEY (agent_id, seq)
);
CREATE INDEX convo_ver ON ot.convo (agent_id, ver);

-- ---------------------------------------------------------------- mail
CREATE TABLE ot.mail (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  uid               text NOT NULL UNIQUE,
  org_id            bigint NOT NULL REFERENCES ot.orgs (id),
  sender            text NOT NULL,            -- agent name, '@user', '@system', '@extern:<addr>'
  sender_agent_id   bigint,
  sender_generation integer,
  recipient_kind    text NOT NULL CHECK (recipient_kind IN ('agent', 'user')),
  recipient_agent_id bigint,
  recipient_name    text NOT NULL,
  kind              text NOT NULL DEFAULT 'message',
  notice            boolean NOT NULL DEFAULT false,
  body              text NOT NULL,
  attachments       jsonb NOT NULL DEFAULT '[]',
  reply_to          jsonb,
  ev                jsonb,
  urgent            boolean NOT NULL DEFAULT false,
  urgent_reason     text,
  relationship      text,
  client_op         text,
  state             text NOT NULL CHECK (state IN ('pending', 'delivering', 'delivered', 'read', 'retracted')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  delivered_at      timestamptz,
  read_at           timestamptz,
  turn_id           bigint,
  extra             jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX mail_agent_pending ON ot.mail (recipient_agent_id, id) WHERE state IN ('pending', 'delivering');
CREATE INDEX mail_agent_box ON ot.mail (recipient_agent_id, id DESC) WHERE recipient_kind = 'agent';
CREATE INDEX mail_sender_box ON ot.mail (sender_agent_id, id DESC) WHERE sender_agent_id IS NOT NULL;
CREATE INDEX mail_user_unread ON ot.mail (org_id, id) WHERE recipient_kind = 'user' AND state = 'pending';
CREATE INDEX mail_user_box ON ot.mail (org_id, id DESC) WHERE recipient_kind = 'user';
CREATE INDEX mail_user_sent ON ot.mail (org_id, id DESC) WHERE sender = '@user';

-- the org's face to the outside world (other orgs, the mail hub)
CREATE TABLE ot.org_inbox (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  uid         text NOT NULL UNIQUE,
  org_id      bigint NOT NULL REFERENCES ot.orgs (id),
  dir         text NOT NULL CHECK (dir IN ('in', 'out')),
  peer        text NOT NULL,
  body        text NOT NULL,
  at          timestamptz NOT NULL DEFAULT now(),
  by_name     text,
  state       text,
  state_at    timestamptz,
  net_id      text,
  tries       integer NOT NULL DEFAULT 0,
  last_err    text,
  attachments jsonb NOT NULL DEFAULT '[]',
  read        boolean NOT NULL DEFAULT false
);
CREATE INDEX org_inbox_org ON ot.org_inbox (org_id, id DESC);
CREATE INDEX org_inbox_unread ON ot.org_inbox (org_id) WHERE dir = 'in' AND NOT read;
CREATE INDEX org_inbox_queued ON ot.org_inbox (org_id, id) WHERE dir = 'out' AND state = 'queued';

-- ---------------------------------------------------------------- asks
CREATE TABLE ot.asks (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  uid         text NOT NULL UNIQUE,
  org_id      bigint NOT NULL REFERENCES ot.orgs (id),
  agent_id    bigint NOT NULL REFERENCES ot.agents (id),
  kind        text NOT NULL,                 -- question | credit | batch
  status      text NOT NULL,                 -- open | answered | dismissed | withdrawn | superseded | denied | granted
  body        jsonb NOT NULL,                -- AskInfo fields (questions/tabs/credit/scope items)
  rev         integer NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  reason      text,
  answer      jsonb,
  answer_mail text,
  work_items  text[] NOT NULL DEFAULT '{}'
);
CREATE INDEX asks_open ON ot.asks (org_id, id) WHERE status = 'open';
CREATE INDEX asks_agent ON ot.asks (agent_id, id DESC);
CREATE INDEX asks_resolved ON ot.asks (org_id, resolved_at DESC) WHERE resolved_at IS NOT NULL;

-- ---------------------------------------------------------------- docket
CREATE TABLE ot.work_items (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id           bigint NOT NULL REFERENCES ot.orgs (id),
  slug             text NOT NULL,
  rev              bigint NOT NULL DEFAULT 1,
  kind             text NOT NULL DEFAULT 'code',
  title            text NOT NULL,
  objective        text NOT NULL DEFAULT '',
  status           text NOT NULL,
  blocked_reason   text,
  dropped_reason   text,
  owner            jsonb,
  owner_agent_id   bigint,
  reviewer         jsonb,
  reviewer_agent_id bigint,
  created_by       jsonb NOT NULL,
  last_updater     jsonb,
  participants     text[] NOT NULL DEFAULT '{}',
  parent           text,
  dependencies     text[] NOT NULL DEFAULT '{}',
  superseded_by    text,
  done_so_far      jsonb NOT NULL DEFAULT '[]',
  working_on_next  jsonb NOT NULL DEFAULT '[]',
  manual_attention jsonb,
  dismissals       jsonb NOT NULL DEFAULT '[]',
  evidence         jsonb NOT NULL DEFAULT '[]',
  accepted         jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  docket_at        timestamptz,
  status_at        timestamptz,
  archived_at      timestamptz,
  extra            jsonb NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX work_items_slug ON ot.work_items (org_id, slug);
CREATE INDEX work_items_active ON ot.work_items (org_id, id) WHERE archived_at IS NULL;
CREATE INDEX work_items_owner ON ot.work_items (owner_agent_id) WHERE archived_at IS NULL;
CREATE INDEX work_items_archived ON ot.work_items (org_id, archived_at DESC) WHERE archived_at IS NOT NULL;

CREATE TABLE ot.work_events (
  id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  work_id bigint NOT NULL REFERENCES ot.work_items (id),
  at      timestamptz NOT NULL DEFAULT now(),
  by      jsonb NOT NULL,
  op      text NOT NULL,
  detail  jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX work_events_item ON ot.work_events (work_id, id);

CREATE TABLE ot.work_attachments (
  id      text PRIMARY KEY,
  work_id bigint NOT NULL REFERENCES ot.work_items (id),
  name    text NOT NULL,
  bytes   bigint NOT NULL,
  path    text NOT NULL,
  at      timestamptz NOT NULL DEFAULT now(),
  by      jsonb NOT NULL
);
CREATE INDEX work_attachments_item ON ot.work_attachments (work_id);

-- per-org docket version: moves on any docket write (ETag for the list)
CREATE TABLE ot.docket_versions (
  org_id  bigint PRIMARY KEY REFERENCES ot.orgs (id),
  version bigint NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------- documents & files
CREATE TABLE ot.documents (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  uid        text NOT NULL UNIQUE,
  org_id     bigint NOT NULL REFERENCES ot.orgs (id),
  agent_id   bigint REFERENCES ot.agents (id),
  node_name  text NOT NULL,
  title      text NOT NULL,
  body       text,
  format     text NOT NULL DEFAULT 'markdown',
  bytes      integer NOT NULL DEFAULT 0,
  at         timestamptz NOT NULL DEFAULT now(),
  dismissed  boolean NOT NULL DEFAULT false,
  replaces   text
);
CREATE INDEX documents_org ON ot.documents (org_id, id DESC);
CREATE INDEX documents_agent ON ot.documents (agent_id, id DESC) WHERE NOT dismissed;

CREATE TABLE ot.deliveries (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  uid       text NOT NULL UNIQUE,
  org_id    bigint NOT NULL REFERENCES ot.orgs (id),
  agent_id  bigint REFERENCES ot.agents (id),
  name      text NOT NULL,
  path      text NOT NULL,
  bytes     bigint NOT NULL DEFAULT 0,
  note      text,
  at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX deliveries_agent ON ot.deliveries (agent_id, id DESC);

-- ---------------------------------------------------------------- events
CREATE TABLE ot.events (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id           bigint NOT NULL REFERENCES ot.orgs (id),
  at               timestamptz NOT NULL DEFAULT now(),
  op               text NOT NULL,
  actor            text NOT NULL,
  subject_agent_id bigint,
  detail           jsonb NOT NULL DEFAULT '{}',
  warnings         jsonb
);
CREATE INDEX events_org ON ot.events (org_id, id DESC);
CREATE INDEX events_subject ON ot.events (subject_agent_id, id DESC) WHERE subject_agent_id IS NOT NULL;

-- ---------------------------------------------------------------- watchdogs
CREATE TABLE ot.watchdogs (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  uid            text NOT NULL UNIQUE,
  org_id         bigint NOT NULL REFERENCES ot.orgs (id),
  owner_agent_id bigint NOT NULL REFERENCES ot.agents (id),
  name           text NOT NULL,
  kind           text NOT NULL,
  target         text NOT NULL,
  pattern        text,
  shell          text,
  interval_s     integer NOT NULL,
  fire_mode      text NOT NULL DEFAULT 'event',
  quiet_period_s integer,
  once           boolean NOT NULL DEFAULT false,
  state          text NOT NULL,
  fired          integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_check     timestamptz,
  last_fired     timestamptz,
  silence_since  timestamptz,
  events         jsonb NOT NULL DEFAULT '[]',
  exit           jsonb,
  spent_at       timestamptz,
  memo           jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX watchdogs_active ON ot.watchdogs (org_id) WHERE state IN ('armed', 'paused');
CREATE INDEX watchdogs_owner ON ot.watchdogs (owner_agent_id);

-- ---------------------------------------------------------------- audiences
CREATE TABLE ot.audiences (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id     bigint NOT NULL REFERENCES ot.orgs (id),
  grantee    text NOT NULL,
  grantor    text NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  reason     text NOT NULL DEFAULT '',
  paused     boolean NOT NULL DEFAULT false,
  revoked_at timestamptz
);
CREATE INDEX audiences_active ON ot.audiences (org_id) WHERE revoked_at IS NULL;

CREATE TABLE ot.audience_requests (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id     bigint NOT NULL REFERENCES ot.orgs (id),
  requester  text NOT NULL,
  target     text NOT NULL,
  reason     text NOT NULL DEFAULT '',
  status     text NOT NULL DEFAULT 'pending',
  at         timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  holder     text
);
CREATE INDEX audience_requests_open ON ot.audience_requests (org_id) WHERE status = 'pending';

-- ---------------------------------------------------------------- accounts (machine-wide)
CREATE TABLE ot.accounts (
  id            text PRIMARY KEY,
  provider      text NOT NULL,
  kind          text NOT NULL,      -- managed | imported | apikey
  label         text NOT NULL DEFAULT '',
  config_dir    text,
  identity      jsonb NOT NULL DEFAULT '{}',
  auth          text NOT NULL DEFAULT 'unobserved',
  tint_ordinal  integer NOT NULL DEFAULT 0,
  origin_org    text,
  enabled       boolean NOT NULL DEFAULT true,
  ord           integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  extra         jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE ot.account_secrets (
  account_id text PRIMARY KEY REFERENCES ot.accounts (id) ON DELETE CASCADE,
  secret     text NOT NULL
);

-- "limited until" marks, per account and pool
CREATE TABLE ot.account_marks (
  account    text NOT NULL,
  pool       text NOT NULL,
  until      timestamptz NOT NULL,
  provenance text NOT NULL DEFAULT 'observed',
  win        text,
  at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account, pool)
);

CREATE TABLE ot.account_spend (
  account    text PRIMARY KEY,
  usd_total  numeric(16, 6) NOT NULL DEFAULT 0,
  turns      integer NOT NULL DEFAULT 0,
  since      timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- uploads (user → agent staging)
CREATE TABLE ot.uploads (
  id        text PRIMARY KEY,
  org_id    bigint NOT NULL REFERENCES ot.orgs (id),
  agent_id  bigint,
  name      text NOT NULL,
  path      text NOT NULL,
  bytes     bigint NOT NULL,
  at        timestamptz NOT NULL DEFAULT now()
);
