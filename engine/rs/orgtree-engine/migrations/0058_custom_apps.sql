-- Custom app definitions and independent, persistent saved panel copies.
-- Executable grants are local to an app revision and never portable.
CREATE TABLE ot.custom_apps (
  org_id bigint NOT NULL REFERENCES ot.orgs(id) ON DELETE CASCADE,
  id text NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  description text NOT NULL DEFAULT '',
  html text NOT NULL CHECK (octet_length(html) BETWEEN 1 AND 4194304),
  initial_state jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(initial_state)='object' AND octet_length(initial_state::text)<=4194304),
  capabilities jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(capabilities)='array'),
  width integer NOT NULL DEFAULT 520 CHECK (width BETWEEN 160 AND 4096),
  height integer NOT NULL DEFAULT 420 CHECK (height BETWEEN 120 AND 4096),
  permissions jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(permissions)='object'),
  rev bigint NOT NULL DEFAULT 1 CHECK (rev>0),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(org_id,id)
);
CREATE TABLE ot.custom_panels (
  org_id bigint NOT NULL,
  id text NOT NULL,
  app_id text NOT NULL,
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 120),
  state jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(state)='object' AND octet_length(state::text)<=4194304),
  rev bigint NOT NULL DEFAULT 1 CHECK (rev>0),
  is_open boolean NOT NULL DEFAULT true,
  placement jsonb NOT NULL DEFAULT '{"mode":"float","x":40,"y":40,"width":520,"height":420}',
  linked_agents jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(linked_agents)='array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  used_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(org_id,id),
  FOREIGN KEY(org_id,app_id) REFERENCES ot.custom_apps(org_id,id) ON DELETE CASCADE
);
CREATE INDEX custom_panels_app_recent ON ot.custom_panels(org_id,app_id,used_at DESC,id DESC);
CREATE TABLE ot.custom_panel_events (
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id bigint NOT NULL,
  panel_id text NOT NULL,
  name text NOT NULL,
  payload jsonb NOT NULL CHECK (octet_length(payload::text)<=131072),
  actor text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(org_id,panel_id) REFERENCES ot.custom_panels(org_id,id) ON DELETE CASCADE
);
CREATE INDEX custom_panel_events_page ON ot.custom_panel_events(org_id,panel_id,seq);
