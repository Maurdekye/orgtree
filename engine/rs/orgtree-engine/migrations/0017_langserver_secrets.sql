-- Language Server lane (crate::langserver): the API key of a user's own model
-- server, when it needs one. Kept apart from ot.account_secrets: a server is
-- not an account (no usage, no fallback, no limit marks). Never returned to a
-- window and never logged.
CREATE TABLE ot.langserver_secrets (
  server_id text PRIMARY KEY,
  secret    text NOT NULL
);
