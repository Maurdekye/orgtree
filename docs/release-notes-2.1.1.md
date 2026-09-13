# Orgtree 2.1.1

Changes since 2.1.0, which is published on GitHub as the previous release. The
installer is unsigned, as every Orgtree release before it has been.

## API keys become ordinary accounts

The old path treated an API key as something one organization owned, set in that
organization's Autonomy tab, with a red border on the office and the agent card
whenever a turn spent it. That whole path is gone, replaced by accounts.

- An API key is now registered the same way any other account is: "Use an API
  key" in the add-account dialog, for Claude and for Codex, whether or not that
  provider's subscription is signed in. Google is not offered, because
  Antigravity has no API-key login.
- Key material is kept in the machine token store for both providers. The
  account row holds only a reference to it, never the key itself. Removing the
  account disposes of the secret; subscription logins cannot be reached through
  that door.
- The Usage panel answers a key account with what it has actually cost in USD,
  plus its turn count, instead of limit bars that could only ever read 0%. An
  account that has never run reads as "never used" rather than as $0.00 spent.
- Two machine-wide switches sit under each provider's account list, because they
  are statements about those accounts: whether signed-in subscriptions may serve
  turns at all, and whether a turn may reach an API-key account once every
  applicable subscription limit is exhausted. Both now act for the provider they
  name — previously they were wired to Claude only while the interface offered
  them for Codex and Antigravity as well. The fallback switch stays hidden until
  an enabled key account exists for that provider.
- API-key fallback is off by default and fires late: a turn reaches a key
  account only once no subscription can serve it. Turning subscription inference
  off for a provider routes that provider's unbound turns to its first enabled
  key account immediately.
- An agent bound to a specific account is never silently rerouted. If its
  account cannot serve, the agent is parked and says so, because moving a turn
  off an explicit binding is exactly what the account rules forbid.
- Codex can now start on a key alone. It previously refused before it had worked
  out which account would pay, so key-only operation was unreachable on that
  provider.
- A key whose credential has been judged unauthenticated is skipped instead of
  holding the lane, so a revoked or mistyped key no longer absorbs every metered
  turn while a healthy key waits behind it.
- A Codex rate limit is now recorded against the key that actually hit it, so
  multi-key rotation moves on to the next key rather than retrying the walled
  one. Subscription rate-limit handling is unchanged.
- Existing organization API keys are migrated into the account registry at
  startup. Bindings survive, the machine fallback switch stays off, and a
  partial migration finishes on the next start rather than blocking it.
- Account selection surfaces name the host login explicitly, and capability
  conclusions are dated so a stale reading is visible as stale.

## Mail hub hosting moves to App Settings

One installation hosts at most one mail hub, but everything about that hub —
whether it listens, where, with which certificate, and which organizations it
admits — was rendered inside a single organization's Connections tab.

- Hosting and grant administration are now in App settings, under a new Mail hub
  tab. An organization's Connections tab keeps only that organization's own side:
  its address, with a copy action, and the hubs it connects out to.
- The grant list is new. The hub always knew which grants it had issued and could
  revoke one, but there was no way to read them. App settings now lists each
  allowed organization with its state, revokes a grant, and replaces a credential
  by rebinding a new secret to the same identifier and organization.
- Authentication is untouched: same token format, same fingerprint admission,
  same exact-organization binding, same TLS verification, same manual exposure.
  Existing hosting configuration, credentials and connections survive the upgrade
  with nothing to re-enter.

## Notifications and attention

- While any attached question, attention ticket or urgent mail is still waiting,
  the Windows taskbar button uses the platform's own attention behaviour and the
  matching toolbar icon carries a small bright dot. Both read one
  cross-organization total, so they cannot disagree; they clear together when
  nothing is left waiting.
- A question card no longer suppresses its own alert merely by being on screen. A
  window on a second monitor, or behind whatever the user is actually working in,
  has shown them nothing, so suppression now requires the card to be in the
  Orgtree window they are in. A deferred alert arrives on the first poll after
  they leave Orgtree; one they genuinely saw stays consumed.
- A busy organization can no longer starve notification delivery. Continuous
  saving used to dirty every dispatch pass before it finished, so nothing reached
  the operating system at all.
- A master notifications switch with safe defaults, plus per-category native
  notification settings.

## Tickets and the Docket

- Docket next actions and handoff requests are routed to the agent that holds the
  next action.
- Ticket descriptions keep a history of scope changes, so a later reader can see
  how the stated scope moved.
- A refused docket write leaves the item byte-identical. A refused reopen, and
  any refused update, no longer leaves a partial change behind, and a docket
  write is never silently truncated.
- Docket categories can be collapsed.
- Ticket evidence is classified by how it was obtained, and an acceptance
  condition can require an executed known-negative control rather than an
  unfalsifiable claim.
- A rename records that a rename happened instead of rewriting the earlier record
  as though the new name had always been there.

## Transcripts and history

- Reading back through a desk's history keeps the reader's place, anchors on
  their own row, and makes a failed page load retryable instead of silently
  stopping.
- Every page request now settles with an outcome, including a failed automatic
  load of an older page, and the viewport keeps its floor through a failure.
- Transcript paging state is released when the renderer resets, and a stale page
  cleanup can no longer discard a newer one.
- Sending from a history view does what the user chose, pinned by a regression.

## Windows, popouts and appearance

- A popped-out modal is a window, so it has a title bar; and a dialog inside a
  window is no longer treated as that window itself.
- Claude agent rows use the shared provider theme.
- Windows development builds carry the branded taskbar metadata.
- The legacy generic-icon Start menu shortcut is removed, so an upgrade no longer
  leaves a second unbranded entry behind.
- A mail fold is measured when its body changes rather than on every render.
- Halt sits beside the other top agent lifecycle actions.
- App Settings charter text, provider actions and section headers are tidied.

## Reliability and diagnostics

- Restart notices report the packaged build identity, so an operator can see
  which commit and version the running installation came from.
- A read-only installed-runtime verifier reports runtime identity and discovery
  without provisioning, starting, stopping or deploying anything.
- Scoped runtime and effective-scope diagnostics, scoped state inspection with
  transition previews, and a redacted view of an agent's account binding.
- Worktree operations are safe and visible, and the ticket sweep names what it
  owns instead of quietly excluding it.
- A turn record distinguishes the send from the acknowledgement, so a refused
  turn no longer reads as "sent and never answered".
- A watchdog can report that it does not know whether a process is alive. A
  permission error no longer announces a death, and an uncertain observation
  leaves the last known state standing rather than accumulating into a confident
  verdict.
- Compaction handoffs preserve the facts a successor needs, and breadcrumb
  encoding survives the round trip.
- Reports are submitted with an explicit audience check.

## Verification and development

- A verification receipt records the candidate commit, a fingerprint of the tree
  the check ran in, the command line, and which of five outcomes came back, so a
  passing log from before an edit cannot read as evidence for after it. A
  supplied base is resolved and proved to be an ancestor rather than taken on
  trust.
- Stored artifacts are addressed by content hash, names are never reused, and a
  failed record no longer leaves unnamed bytes behind.
- Shared verification fixtures and replay recipes, scoped resource reservations,
  integration receipts, and recorded review verdicts for a candidate.
- An isolated Python verification runner gives each test module its own
  interpreter and data root, and renderer and root test runs no longer interfere
  with each other.
