# Failed shell output

User 2026-10-13 18:56UTC requested collapsed Bash/PowerShell errors, expandable
on demand. The shared tool row shows “an error occurred” for failed shell calls,
uses its existing fold and supports Enter/Space. Successful shells and other
tools preserve their previous presentation. All views using `Msg` share it.

Coordinator 19:00UTC authorized retaining failed shell output beyond the usual
4,000-character result/500-character gist. Runtime Claude, Codex, Muse and Agy
result adapters, and newly imported Claude-shaped history, retain only failed
shell output (Bash/PowerShell and their existing `exec_command`, `run_command`,
`run_shell_command` and `shell` aliases). This uses the existing per-call
`tool_inputs` JSON storage, atomically merged by call ID with input details;
conversation deletion/retention therefore deletes both. No migration or extra
history scan is introduced.

The full output is removed before durable chat bodies and pending feed frames.
Only `output_seq` survives on the chip. Authenticated
`GET /api/orgs/{slug}/nodes/{nid}/tooloutput/{seq}/{tool}` resolves current
org/node and reads that agent/sequence/tool directly. The route, extraction and
retention helper omit raw logging; HTTP body logging excludes this route.

Expansion fetches output with a stale-identity guard and Retry on errors. Text
stays inert/selectable and uses the existing code-copy affordance. Retention
keeps at most 1 MiB of UTF-8 bytes on a character boundary; expansion explicitly
says “output truncated at 1 MiB” if capped. If the provider reports prior
truncation, expansion says so. Older stored calls without retained output show
their available text and disclose historical clipping; absent bytes cannot be
recovered.

Focused renderer tests passed 3/3 at c2e46e4. Two native helper tests and an
eleven-check scratch route proof are prepared, not yet executed. Synthetic
before/after visuals and final exact-source verification remain pending.
No installed-app, actual provider or real shell execution acceptance is claimed.
