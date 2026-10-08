# Hub attachment limits

The standalone hub defaults to 1 GiB (1,073,741,824 bytes), configurable with
`HUB_MAX_FILE_BYTES`. Its public `/healthz.max_attachment_bytes` is the client
contract. The hosted hub gets `HUB_RUNTIME_CONFIG_FILE`: a small local JSON file
whose value overrides the startup default. Orgtree saves that file atomically
when only the maximum changes; it does not restart the hub. An upload snapshots
its limit at the start, so changes affect subsequent uploads.

App settings → Mail hub exposes the value in MiB. Orgtree checks the selected
target hub before copying an agent's attachment, staging a user's file, queuing
mail and uploading the spool file. A multi-recipient user upload checks the
smallest limit. Hubs without the capability keep the old 25 MiB allowance, with
the explicit error “this hub doesn't state its limit; using 25 MB”. Local
organization mail keeps its existing limit.

Hub uploads, desktop staging, outbound HTTP bodies and inbound downloads stream
chunks to/from disk. File transfers have a one-hour request timeout. Upload
progress, background transfer scheduling, cancellation and restart recovery are
the separate `long-running-attachment-transfers-progress-for-u` item; the existing
mail spool still owns delivery in this change.

## Verification

- Hub `python tests/test_hub.py`: 62 checks pass, with one previously documented
  unrelated path-validation gap. New checks cover env/default, health response,
  runtime updates, oversize/interrupt cleanup, snapshot semantics and a 32 MiB
  upload with less than 8 MiB peak traced Python allocation.
- `cargo check`, debug build and `npm run typecheck` pass.
- Renderer `attachment-limits` and `mailhubsettings`: four checks pass, including
  multi-recipient preflight and the form's MiB-to-byte conversion.
- `node tools/rig/rig.mjs run tools/rig/proofs/attachment-limits.mjs`: real settings,
  raw streamed staging and agent-tool paths; nine assertions. Add `--ui <bundle>`
  for a tenth assertion and screenshot of a real settings save.

The debug rig reads canned health documents from `rig-hub-limits.json`, keyed by
`@net:<peer>`. This hook is absent from release builds and requires validated rig
mode. No actual hub registration/listener or end-to-end network delivery is
exercised. A whole 1 GiB transfer and production proxy limits are not measured.
Hubchat's use of the capability is a separate client's implementation.

The hub work remains in its separate branch; this change does not bump the
parent repository's submodule pin or publish either repository.
