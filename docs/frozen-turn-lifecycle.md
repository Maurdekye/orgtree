# Frozen Claude turn: diagnosis and source fix

A cold Claude turn can stop after any completed tool call when its diagnostic pipe fills. The supervisor was reading stdout while leaving stderr unread until stdout ended. A blocked stderr write stops the CLI from reaching its next tool hook or model response. The idle watchdog then killed the command-shell launcher, leaving Claude and its MCP child alive with inherited pipes. The supervisor never received stdout EOF, so its turn cleanup never ran.

This is the sequence reproduced by the regression tests and supported by the preserved hire-tool incident. It is independent of which tool the agent had just completed.

| UTC, 2026-09-11 | Observation |
| --- | --- |
| 19:08:29 | Turn recorder opened attempt `18d459d1d7bf57f8-0005`. |
| 19:08:34.205 | Command-shell launcher PID 33780 was created. |
| 19:08:34.248 | Warm journal recorded a **cold** admission, reason `no-process`. |
| 19:08:34 | Claude PID 11080 started under launcher 33780. |
| 19:08:35 | Claude started MCP child PID 24752. |
| 19:13:26.675 | Native transcript recorded the final tool result: eight renderer tests passed in 15.277 seconds. |
| 19:13:26.677 | Last native attachment was written. No later transcript activity was found. |
| 19:23:35.771 | Launcher 33780 exited with code 1. Claude and its MCP child remained alive. |
| About 20:08 | Coordinator observed two interrupt calls returning exactly `{"interrupted":true}`; queued mail remained unread. |
| 20:11:29 | Retire freed five credits and warned that settlement had not completed after ten seconds. |
| 20:11:41 | Rehire returned while the same original attempt still remained active. |

The launcher exit time came from its retained Windows process handle in engine PID 9964. It is 609.096 seconds after the final tool result, consistent with the 600-second watchdog and its five-second polling interval. The watchdog **did fire**. `Popen.kill()` terminated the launcher, rather than the process tree.

Read-only pipe inspection found an engine read-side pipe with 4,290 bytes buffered against a 4,096-byte quota. A metadata query on Claude's stderr handle blocked; the equivalent stdout query returned immediately. These observations support a pending blocked stderr write. The exact diagnostic line was not recovered: no bytes were consumed from the live pipes. The last individual write is therefore not claimed as recorded evidence; the pipe deadlock and launcher-only termination are reproduced directly with local children.

The installed version is 2.0.8, build commit `7cd48de`. Its supervisor source matches main's incident source byte for byte, SHA-256 `cbd125df990c879bd0d1b7cb6adb9144bc1b2565b9ba2f2e3f2efb839ab1f7a5`. The implementation branch starts at `4f9112f`. Private evidence and bounded metadata probes are preserved in `E:/Libraries/Desktop/orgtree/.worktrees/freeze-astra/incident/`. The copied partial record has SHA-256 `65ab3ed3b7eecb655e64d27c61c3c5431311175e86d5357cfded21c72dd6a375`.

The partial record is a write-once opening stub. Its empty events and null fields are initialization defaults, not evidence that the turn produced no output. Its continued presence and missing final sibling show that the recorder did not finalize. The retained live child, cold-admission journal, native transcript, and process exit timestamp locate this failure in the provider pipe lifecycle, rather than admission or transcript ingestion.

`interrupt_turn` previously accepted success after writing and flushing a control request to stdin. A child can keep that pipe writable after its launcher has exited. The successful write neither proved receipt nor caused a blocked CLI to consume it. `orgtree_unstick` addresses a recorded frozen/replay condition; this attempt had no such classification.

The earlier interrupt-before-retire fix correctly added interruption before archive and waited for `busy` to clear. In this incident it ran, waited, and warned as designed. It could not release a thread waiting for pipe EOF. Rehire also preserved that in-memory busy state. This source fix addresses the lower-level process and pipe failure rather than changing the archive policy.

The failure conditions are a cold spawn, sufficient stderr output, and a launcher whose descendants retain the standard handles when it dies. A new turn without a pooled process, or a warm claim that falls back to cold launch, can enter the same path. Warm processes already have a concurrent stderr reader, but their output consumers also need an explicit stop path when process cleanup does not produce EOF. The existing watchdog limits still apply to foreground and background work.

The implementation makes these changes:

- Drain cold stderr immediately after every spawn, including the warm-claim fallback, independently of stdout and readiness waiting. Keep a diagnostic tail bounded to 64K characters and 200 chunks. Cache warnings still reach the existing journal; an observer exception cannot stop draining.
- Pump cold stdout into a bounded queue. Cold and warm consumers can stop explicitly after timeout even if inherited writers prevent EOF. Queue backpressure also releases when the consumer exits.
- Terminate the process tree before its launcher disappears, then signal the stream consumer in a `finally` block. Bound process-exit and diagnostic-drain waits so final accounting, queued-mail handoff, and the turn recorder can finish.
- Refuse to report interrupt success for a launcher already known to have exited. Graceful interruption of a live CLI retains the existing protocol.

Before implementation, the two initial full-runner tests failed on the incident source: diagnostic pressure stranded the turn, and the watchdog killed a Windows wrapper while its child held the pipes open. The graceful-interrupt positive control passed. On the fix, ten lifecycle tests pass, covering those cases, actual child death, queued-mail preservation, final killed records, readiness before the first prompt, bounded diagnostics without newlines, journal failure, early cache-warning capture, inherited-handle cleanup, warm-reader cancellation, and interrupt-before-archive settlement.

Related validation passes: eight existing admission/interruption checks, ten account/spawn-environment checks, and eleven shutdown/hold checks. The first concurrent admission run hit an existing one-second timing assertion; the unchanged-main comparison and the serial branch rerun both passed all eight. That fixture also logs missing-org transcript-capture warnings on both versions. Source syntax parsing and `git diff --check` pass.

The branch is for coordinator review. The frozen live specimen has not been interrupted, killed, or otherwise changed by this investigation. No installation, update, push, deployment, or restart has been performed. Installation requires the user to be present.
