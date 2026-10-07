-- A reference writer holds the referenced account row until its commit.
-- Removal takes that row exclusively before draining references. This covers
-- cached account choices on every door, without a machine-wide application lock.
CREATE TABLE ot.removed_accounts (
  id text PRIMARY KEY,
  provider text NOT NULL,
  removed_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION ot.check_account_reference(aid text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF aid IS NULL OR aid = '' OR aid IN ('primary', 'default', 'claude/primary', 'openai/primary', 'google/primary') THEN
    RETURN;
  END IF;
  PERFORM id FROM ot.accounts WHERE id = aid FOR KEY SHARE;
  -- Legacy imports can contain missing-account placeholders and copy their
  -- registry after their orgs. Reject deleted identities, without inventing a
  -- new validation policy for those pre-existing import cases.
  IF NOT FOUND AND EXISTS (SELECT 1 FROM ot.removed_accounts WHERE id = aid) THEN
    RAISE EXCEPTION 'account % was removed; choose primary or an existing account', aid
      USING ERRCODE = '23503';
  END IF;
END;
$$;

CREATE FUNCTION ot.guard_agent_accounts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.account IS DISTINCT FROM OLD.account THEN
    PERFORM ot.check_account_reference(NEW.account);
  END IF;
  IF TG_OP = 'INSERT' OR NEW.pending_account->>'account' IS DISTINCT FROM OLD.pending_account->>'account' THEN
    PERFORM ot.check_account_reference(NEW.pending_account->>'account');
  END IF;
  IF TG_OP = 'INSERT' OR NEW.pending_switch->>'account' IS DISTINCT FROM OLD.pending_switch->>'account' THEN
    PERFORM ot.check_account_reference(NEW.pending_switch->>'account');
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER agent_accounts BEFORE INSERT OR UPDATE OF account, pending_account, pending_switch
  ON ot.agents FOR EACH ROW EXECUTE FUNCTION ot.guard_agent_accounts();

CREATE FUNCTION ot.guard_default_account() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE next_account text; old_account text;
BEGIN
  IF TG_TABLE_NAME = 'orgs' THEN
    next_account := NEW.settings->>'default_account';
    IF TG_OP = 'UPDATE' THEN old_account := OLD.settings->>'default_account'; END IF;
  ELSIF NEW.key = 'app_settings' THEN
    next_account := NEW.value #>> '{defaults,default_account}';
    IF TG_OP = 'UPDATE' THEN old_account := OLD.value #>> '{defaults,default_account}'; END IF;
  END IF;
  IF next_account IS DISTINCT FROM old_account THEN
    PERFORM ot.check_account_reference(next_account);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER org_default_account BEFORE INSERT OR UPDATE OF settings
  ON ot.orgs FOR EACH ROW EXECUTE FUNCTION ot.guard_default_account();
CREATE TRIGGER app_default_account BEFORE INSERT OR UPDATE OF value
  ON ot.kv FOR EACH ROW EXECUTE FUNCTION ot.guard_default_account();

CREATE INDEX agents_account_reference ON ot.agents (account, id) WHERE account IS NOT NULL;
CREATE INDEX agents_pending_account_reference ON ot.agents ((pending_account->>'account'), id)
  WHERE pending_account IS NOT NULL;
CREATE INDEX agents_pending_switch_account_reference ON ot.agents ((pending_switch->>'account'), id)
  WHERE pending_switch IS NOT NULL;
CREATE INDEX orgs_default_account_reference ON ot.orgs ((settings->>'default_account'), id);
