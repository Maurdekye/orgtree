-- Usage over time (docket track-usage-over-time-and-show-usage-analytics,
-- phase 1: recorded only, nothing reads it yet). Append-only: one row per
-- observation that differs from the series' last one (and at most hourly
-- when nothing changed), one row per account for its availability, and a
-- 'reset' row where a window restarted, so a later graph never draws a reset
-- as consumption. A value the provider did not report is NULL, never zero.
-- Rows older than 90 days are pruned in small batches.
CREATE TABLE ot.usage_history (
  id             bigserial PRIMARY KEY,
  -- when the provider was asked (the reading's own time)
  observed_at    timestamptz NOT NULL,
  recorded_at    timestamptz NOT NULL DEFAULT now(),
  provider       text NOT NULL,
  account        text NOT NULL,
  -- the allowance window (session, weekly_all, ...); '' = the account itself
  win            text NOT NULL DEFAULT '',
  grp            text NOT NULL DEFAULT '',
  -- the model scope of a scoped window; '' = every model
  model          text NOT NULL DEFAULT '',
  event          text NOT NULL DEFAULT 'reading' CHECK (event IN ('reading', 'reset')),
  state          text NOT NULL CHECK (state IN ('ok', 'unavailable', 'unsupported', 'stale', 'inferred')),
  used_pct       double precision,
  amount         double precision,
  unit           text,
  resets_at      timestamptz,
  -- a reset row: the series' last reading before it
  prev_pct       double precision,
  prev_amount    double precision,
  prev_resets_at timestamptz,
  label          text,
  -- why a reading is unavailable (never a credential)
  detail         text
);

CREATE INDEX usage_history_series ON ot.usage_history (account, win, grp, model, observed_at DESC);
CREATE INDEX usage_history_age ON ot.usage_history (observed_at);
