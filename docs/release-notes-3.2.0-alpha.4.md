# Orgtree 3.2.0-alpha.4 (local test build)

Local test build of the 3.2.0 data-model rewrite. Not published.

Changes since 3.2.0-alpha.3:

- Agent panels, chat and mailboxes now update from the live record feed instead of polling, and record-feed failures show in the attention inbox.
- Steering an agent no longer loses queued mail when the steer is rolled back at the end of a turn, and steer restarts recover from lock timeouts.
- Cache forecasts are computed in the background so they no longer slow the record feed.
- Abandoned docket cleanup is bounded and backs off after failures instead of retrying endlessly.
- The scratch view refreshes from agent activity instead of polling.
