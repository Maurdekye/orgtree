# Orgtree 2.1.4

This release finishes interactive upgrades without any clicks after approval,
brings account cards to every provider with multiple accounts, and improves
mail and messaging behavior.

## Upgrading an existing installation

A successful interactive upgrade now completes on its own: Setup closes
automatically when it finishes, and Orgtree starts exactly once after Setup
exits. Fresh installs, failed or cancelled upgrades, and silent automatic
background updates behave as before.

## Account cards

- Account cards appear for every provider with multiple registered accounts —
  Claude and Codex alike — on agent nodes, desk headers, and pinned desk title
  bars, using compact card typography.
- The visible account token is `default` for the provider's default
  subscription account, the immutable secondary account ID for a secondary
  subscription account, or the first 8 characters of the key for API-key
  authentication.

## Mail and messaging

- Reply navigation uses a compact jump link, and expanded messages remain open
  after sending.
- Message delivery at turn boundaries is durable across restarts and queued
  work.
- Mail addressed to the user supports attachments without an artificial size
  cap.
- Mailhub joining uses address-only configuration for simpler, predictable
  connections.
- External inbox access is limited to one holder, and revealed retired agents
  can be dismissed directly.

## Interface

- Far-zoom views keep model-token information visible, and Codex cards show
  serving-account details accurately.
- The Antigravity secondary-account modal links to
  google-antigravity/antigravity-cli issue #381 when managed or imported
  account sections are unavailable.

## Everything else

Fresh installs, uninstalls, the advanced setup path, install location and
scope selection, and automatic background updates are otherwise unchanged.
