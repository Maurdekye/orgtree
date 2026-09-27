# Stream delivery diagnostics

The scale client defaults to `--stream-mode independent`: each agent has one
ordered producer and at most one request in flight. A slow submission applies
backpressure only to that agent. `--stream-mode batch` retains the previous
sequential multi-agent request for comparison; its later markers include the
time spent processing earlier agents. Runs record the selected mode in config.

The disposable scale server enables stage receipts only with
`ORGTREE_SCALE_FEED_TRACE=1`. Add `ORGTREE_SCALE_FEED_WAITS=1` for SQL and pool
timings. Both are off by default: no wrappers or timing calls are installed on
the engine's capture, SQL or connection-pool paths when tracing is disabled.
The production engine does not import this instrumentation.

Join bounded server receipts with the client's first-arrival marker receipts.
CPU aggregates distinguish all identity/snapshot calls from calls inside a
marked stream capture. Wait records include the capture stage, SQL operation
(not SQL parameters), checkout/release, connection creation (`pg:connect`),
and pool-lock acquisition (`pg:checkout:pool-lock`, `pg:release:pool-lock`).
Checkout totals include their connection and lock subspans: do not add nested
durations. Wall time can include scheduling and client I/O; it does not prove a
database server lock wait. Trace overflow is counted explicitly.
