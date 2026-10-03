-- A4: current policy requests and grants, independent of retained history.
-- Asks/scope/credit request indexes are shared with A1's 0006; do not duplicate.
CREATE INDEX audience_requests_policy_open ON orgtree.audience_requests (ord, id)
  WHERE status IN ('open','pending');
CREATE INDEX audience_grants_policy_grantee ON orgtree.audience_grants (grantee, ord);
