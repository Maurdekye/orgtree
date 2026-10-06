# Orgtree 3.2.0-alpha.5 (local test build)

Local test build of the 3.2.0 data-model rewrite. Not published.

Changes since 3.2.0-alpha.4:

- App-wide values (sign-in state, notices, desktop notifications) now come from a live app feed instead of polling. Finishing a sign-in in the terminal completes properly.
- Moving an agent: the tree places it where the move will end up before the move is confirmed, and refreshes straight away once it is.
- Warm Claude processes are safer: MCP credentials rotate between turns, background work must finish before a process is parked, and leftover child processes are cleaned up.
