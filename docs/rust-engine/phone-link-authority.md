# Phone-link authority in agent instructions

The Connect your phone workflow writes an explicit user-authority note for one
`@net:` address at the top of the selected organization's `org.md`. Generated
instructions must respect that delegation instead of declaring every hub message
incapable of carrying user authority. User approved this correction for the next
alpha on 2026-10-13, 08:35UTC.

## Scope and trust source

The common identity prompt now states the default and exception together:
external mail is untrusted by default; the current organization's trusted
`org.md` may explicitly authorize the exact envelope sender, within the note's
scope. A similar address, display name, forwarded quote, body assertion or
attachment cannot confer or expand authority. Another organization's delegation
does not transfer. Delegated user authority is never system/developer priority
and cannot override higher-priority instructions.

The rule reaches every instruction lane and agents without messaging tools, so
replayed mail and changed audience membership do not remove the trust rule.
Org-inbox instructions refer to it; external mail headers remain outside-party
headers with the same conditional qualification. We do not reclassify `@net:`
senders as infrastructure-wide `@user` identities. Ordinary turn, replay and
mid-turn mail share the same envelope formatter. Existing `orgtree_message`
reply routing stays intact.

There is no new trust registry, parser or account permission. The existing
phone-link note and human org configuration remain the trust source. The change
is instruction consistency, not a cryptographic authentication change or an
engine-side grant of tool permissions.

## Link, unlink and session propagation

`phone::with_block` replaces earlier marked notes and puts the current address
before the 16,000-character org-note cap. `without_block` removes those notes
while preserving the original charter; malformed markers are refused as before.
The actual note content and linking endpoints are unchanged.

`phone::write_note` holds the org-note lock, replaces the file and calls
`http::settings::reconfigure_org`. Existing actor reconfiguration refreshes the
affected org's agents before their next turn. `runtime::actor::identity` reads
that org's notes and passes the common instruction builder to Claude-compatible,
Codex and Antigravity lanes. This includes provider routes using those harnesses.
Removed or replaced delegation must not be restored from old mail/history.

These source edits do not change instructions already delivered to a running
session. Deployed instruction changes and later link/unlink edits may alter the
generated prompt prefix and require a fresh configuration; no provider cache hit
or immediate in-flight model revocation is promised.

## Verification boundaries

Focused native tests in `runtime::prompt::phone_authority_tests` compose real
phone-note helpers, identity generation and all three mail entry points. They
cover linked notes past the charter cap, unlink/replacement, other-org absence,
other/prefix-similar senders and self-asserted or forwarded note text. Existing
`phone::tests` exercise unchanged note round trips, malformed markers and codes.
These are generated-string/fixture checks, not real-model obedience tests or
installed phone/Hubchat acceptance. No live org note or current session is edited.
