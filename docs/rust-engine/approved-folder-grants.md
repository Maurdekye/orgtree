# User-approved folder grants enter organization defaults

The HTTP scope editor and request approval previously raised agent/ancestor
configured folders without raising the organization ceiling. A user could
approve an outside folder and still receive CLAMPED. This omitted the recorded
2026-08-08 3.x rule (Python `ledger.py:8082`, request resolver `set_scope(USER)`),
already implemented by Rust user retool and described in tree-scope parity P56.

The shared HTTP mutation now raises org folders in the same transaction as
child/ancestor scope and the request's answer. It reuses `scope::raise`'s union
and adequate RO/RW coverage semantics, preserving unrelated org settings.
Only actual user-authorized positive folder intent enters the org:

- A direct whole-list scope save contributes newly added paths and RO-to-RW
  upgrades. Unchanged dormant entries, removals and downgrades contribute nothing.
- A request contributes exactly its approved folder items. Explicit reapproval
  of retained clamped intent counts even if its raw folder was already present.
- Deny/skip, other scope axes, inspection and ordinary agent actions contribute
  no folder authorization. Agent retool still cannot grant above itself.

Org-folder settings/revocation, user scope/approval, and user retool/rehire
take the org row before agent rows. This is an org-local transaction lock,
not a global runtime lock. A failed transaction publishes no effects. After
commit, org-folder expansion publishes the org change and refreshes live
agents across the org, since retained scope on other branches may become
effective. Without org expansion, a cascade refresh starts from the highest
raised ancestor. Effort validation and live effort delivery are unchanged.

No historical approvals are replayed and no directory or OS permission is
created. Previously clamped grants remain raw intent: manually adding the
matching org ceiling still revives them if the raw child/ancestor grants remain.
Genuinely revoked or replaced raw grants must be restored explicitly. An absent
directory remains a launch concern: create it before scope refresh/fresh CLI
launch; Claude omits nonexistent paths when launching. Existing running turns
retain their process until the safe replacement boundary.

## Focused proof

`tools/rig/proofs/approved-folder-grants.mjs` uses real HTTP/agent-tool routes
and synthetic disposable rig state. It covers top-level and deep approvals,
RO/RW, explicit retry of a stored clamped grant, unrelated latent exclusions,
mixed/all deny/skip, ordinary-agent refusal, user revocation, existing user
retool, concurrent approvals/settings/retool, separate-org isolation, next
fake-CLI launch and an injected answer-mail failure rolling all state back.
Latent-grant seeding and the failure trigger touch only the disposable rig.

The predecessor uses the already-built `687ab67` engine, SHA256
`f203efb26de7550d4b9e9890f3314e76e0591da514dfa0c77bdf98d128c50f4f`.
The audited approval/scope region is unchanged at current base `cf7668e`;
this is not a fresh base build. Its actual receipt has ten named failures.
Corrected verification and its measured limits will be appended at hand-in.

The older `scope-requests.mjs` expected outside-org clamping and partial RO
after user approval. Those expectations are corrected because they encoded
the omission, contrary to the recorded rule; its other request/routing controls
are preserved. No real provider, external organization's private data, live
settings, filesystem permission, installer or pixel acceptance is claimed.
