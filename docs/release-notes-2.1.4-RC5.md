# Orgtree 2.1.4-RC5

- Reply navigation uses a compact jump link, and expanded messages remain open after sending.
- Far-zoom views continue to show model-token information, with serving-account details shown accurately on Codex cards.
- Turn-boundary message delivery remains durable across restarts and queued work.
- External inbox access is limited to one holder, and revealed retired agents can be dismissed directly.
- Mailhub joining uses address-only configuration for simpler, predictable connections.
- User-directed mail supports attachments without an artificial size cap.
- The installed Python runtime keeps every backend dependency under the embedded interpreter's `Lib/site-packages` location, and packaging verifies the complete runtime layout and imports — in the packaged tree and inside the built installer's own payload — before a release candidate is produced.
- Successful interactive upgrades close Setup automatically, show no error dialog, and relaunch Orgtree exactly once after Setup exits; fresh, failed or cancelled, and silent flows retain their existing behavior.
- Account cards appear for every provider with multiple accounts — Claude and Codex alike — on agent nodes, desk headers, and pinned desk title bars, using compact card typography. The visible token is `default` for the provider's default subscription account, the immutable secondary account ID for a secondary subscription account, or the first 8 API-key characters for API-key authentication.
- The Antigravity secondary-account modal links to google-antigravity/antigravity-cli issue #381 when managed or imported account sections are unavailable.
