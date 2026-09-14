# Orgtree 2.1.4-RC4

- Reply navigation uses a compact jump link, and expanded messages remain open after sending.
- Far-zoom views continue to show model-token information, with serving-account details shown accurately on Codex cards.
- Turn-boundary message delivery remains durable across restarts and queued work.
- External inbox access is limited to one holder, and revealed retired agents can be dismissed directly.
- Mailhub joining uses address-only configuration for simpler, predictable connections.
- User-directed mail supports attachments without an artificial size cap.
- Codex account cards show exactly `default` for the default subscription account, the immutable secondary account ID for a secondary subscription account, or the first 8 API-key characters for API-key authentication.
- Successful interactive upgrades close Setup automatically and relaunch Orgtree once after Setup exits; fresh, failed or cancelled, and silent flows retain their existing behavior.
- The Antigravity secondary-account modal links to google-antigravity/antigravity-cli issue #381 when managed or imported account sections are unavailable.
