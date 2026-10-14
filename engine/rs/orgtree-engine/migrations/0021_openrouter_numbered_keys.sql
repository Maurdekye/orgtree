-- Every OpenRouter key has a numbered id (user 2026-10-14 18:00Z, docket
-- openrouter-keys-are-all-equal-no-unnumbered-prim). Up to 4.3.0-alpha.3 the
-- first key was the row `openrouter-key`, named by the lane `openrouter`
-- everywhere a lane is named, and added keys were `openrouter-N` (N >= 2).
-- That first key becomes `openrouter-1`, or the next number nobody used if
-- 1 was ever taken, and everything that named it by either old name follows.
-- Its place in the key list stays first, and every OpenRouter seat that
-- billed it without a binding (no account, `primary`, `default`) is bound to
-- it explicitly, so no agent changes key. A no-op without an `openrouter-key`
-- row, so it is safe on any install.
DO $$
DECLARE
  old_ids text[] := ARRAY['openrouter-key', 'openrouter'];
  new_id text;
  n bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM ot.accounts WHERE id = 'openrouter-key') THEN
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM ot.accounts WHERE id = 'openrouter-1')
     OR EXISTS (SELECT 1 FROM ot.removed_accounts WHERE id = 'openrouter-1') THEN
    SELECT coalesce(max(substring(id FROM '^openrouter-([0-9]+)$')::bigint), 0) + 1 INTO n
      FROM (SELECT id FROM ot.accounts UNION ALL SELECT id FROM ot.removed_accounts) ids;
  ELSE
    n := 1;
  END IF;
  new_id := 'openrouter-' || n;

  -- The row under its new id (every column copied), first in the key list.
  -- The old placeholder label "OpenRouter" was never a name the user gave.
  INSERT INTO ot.accounts
    SELECT (jsonb_populate_record(NULL::ot.accounts, to_jsonb(a) || jsonb_build_object(
      'id', new_id,
      'label', CASE WHEN a.label = 'OpenRouter' THEN '' ELSE a.label END,
      'ord', least(a.ord, coalesce((SELECT min(o.ord) FROM ot.accounts o
                                     WHERE o.provider = 'openrouter' AND o.id <> 'openrouter-key'), a.ord + 1) - 1)))).*
    FROM ot.accounts a WHERE a.id = 'openrouter-key';
  UPDATE ot.account_secrets SET account_id = new_id WHERE account_id = 'openrouter-key';

  -- Agent bindings, including pending ones; unbound OpenRouter seats are bound.
  UPDATE ot.agents SET account = new_id
   WHERE account = ANY (old_ids)
      OR (tier LIKE 'or-%' AND (account IS NULL OR account IN ('', 'primary', 'default')));
  UPDATE ot.agents SET pending_account = jsonb_set(pending_account, '{account}', to_jsonb(new_id))
   WHERE pending_account->>'account' = ANY (old_ids);
  UPDATE ot.agents SET pending_switch = jsonb_set(pending_switch, '{account}', to_jsonb(new_id))
   WHERE pending_switch->>'account' = ANY (old_ids);

  -- History, marks and spend: one series under the new id.
  UPDATE ot.turns SET account = new_id WHERE account = ANY (old_ids);
  UPDATE ot.usage_history SET account = new_id WHERE account = ANY (old_ids);
  UPDATE ot.account_mark_audit SET account = new_id WHERE account = ANY (old_ids);
  -- (account, pool) is unique: keep the latest mark per pool.
  DELETE FROM ot.account_marks m WHERE (m.account = ANY (old_ids) OR m.account = new_id) AND EXISTS (
    SELECT 1 FROM ot.account_marks o WHERE o.pool = m.pool AND (o.account = ANY (old_ids) OR o.account = new_id)
      AND (o.until > m.until OR (o.until = m.until AND o.account < m.account)));
  UPDATE ot.account_marks SET account = new_id WHERE account = ANY (old_ids);
  INSERT INTO ot.account_spend (account, usd_total, turns, since, updated_at)
    SELECT new_id, sum(usd_total), sum(turns), min(since), max(updated_at)
      FROM ot.account_spend WHERE account = ANY (old_ids) OR account = new_id
    HAVING count(*) > 0
    ON CONFLICT (account) DO UPDATE SET usd_total = EXCLUDED.usd_total, turns = EXCLUDED.turns,
      since = EXCLUDED.since, updated_at = EXCLUDED.updated_at;
  DELETE FROM ot.account_spend WHERE account = ANY (old_ids);

  -- Hire defaults and per-org switched-off lanes.
  UPDATE ot.orgs SET settings = jsonb_set(settings, '{default_account}', to_jsonb(new_id))
   WHERE settings->>'default_account' = ANY (old_ids);
  UPDATE ot.orgs SET settings = jsonb_set(settings, '{disabled_accounts}', (
      SELECT coalesce(jsonb_agg(DISTINCT CASE WHEN e = ANY (old_ids) THEN new_id ELSE e END), '[]'::jsonb)
        FROM jsonb_array_elements_text(settings->'disabled_accounts') e))
   WHERE jsonb_typeof(settings->'disabled_accounts') = 'array'
     AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(settings->'disabled_accounts') e WHERE e = ANY (old_ids));
  UPDATE ot.kv SET value = jsonb_set(value, '{defaults,default_account}', to_jsonb(new_id))
   WHERE key = 'app_settings' AND value #>> '{defaults,default_account}' = ANY (old_ids);

  DELETE FROM ot.accounts WHERE id = 'openrouter-key';
  -- A stale reference by an old name is refused, never stored again.
  INSERT INTO ot.removed_accounts (id, provider) VALUES ('openrouter-key', 'openrouter'), ('openrouter', 'openrouter')
    ON CONFLICT (id) DO NOTHING;
END;
$$;
