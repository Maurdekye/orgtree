# Mail and artifact parity: P11–P17, P28, P38

2026-10-07. Reference: Python engine at `4ddbfb13c66ebd5ddb1cc061357fee90384b1d41`.
These behaviors were retained by PLAN §10 D2/D3/G1/I1/I2b. No renderer change.

| Finding | Disposition | Restored behavior |
|---|---|---|
| P13 | Fixed | At most ten attachments; user attachments are authorized and copied; network attachments are scratch-only and at most 25 MB; unsupported local destinations refuse. Snapshots remain stable when the source changes, including an existing outbox source. |
| P17 | Fixed | Presentation, delivery and attachment reads clamp scope from org ceiling through every ancestor, and check canonical file/root containment. |
| P15 | Fixed | Only live, unpaused holders receive outside mail. With none, the first live top-level agent gets a persisted audience. |
| P11 | Fixed | Own waiting inbox uses keyset pagination (50 default, 200 max). Fetch accepts up to 20 IDs, serves at most 256 KB of content, and defers overflow. Bodies are split at UTF-8 boundaries into at most 64 KB chunks with whole/chunk SHA-256 digests. A continuation is bound to agent, message and body digest and survives restart because mail bodies are durable. No other mailbox, including sent-to-others mail, is readable through this tool. |
| P12 | Fixed | Public delivery_id and pre-dispatch ID allocation return the same delivery on retry. A provider tool-use ID yields a stable scoped ID; failures disclose the ID for explicit retries. Concurrent attempts select the single stored delivery; the delivery/event transaction is atomic. |
| P14 | Fixed | A top-level external sender acquires org-inbox reply ownership automatically; lower agents require a held audience. |
| P16 | Fixed | New HTML presentations snapshot local HTML/CSS dependency closure, bounded to 25 MB and 4096 files, reject escape/protected/missing assets, retain ordinary HTML for single-file downloads and ZIP with original relative paths for asset bundles. Offline preview uses embedded data resources under sandbox CSP with no network. |
| P28 | Fixed | Explicit/automatic grants revoke previous holders in single-holder mode; reads bound legacy duplicates to the latest live holder. Disabling multi-holder while multiple live holders remain refuses. Grant/bootstrap/settings mutations share a short per-org row transaction. |
| P38 | Fixed | Unreadable staged network attachments are removed, recorded in an event and delivery note, and remaining files/body continue. Network/HTTP upload failures still retry. |

## Verification and limits

Measured: `cargo check --offline -j 2` passes. Brief isolated Rust smoke exercises production
file/scope functions, UTF-8 chunks, HTML capture and ZIP generation. It proves canonical
out-of-scope denial, stale ancestor clamp, source-edit snapshot isolation, network folder/size
refusals, multi-byte boundary reassembly, empty/invalid chunk handling, nested CSS assets,
single-file HTML and missing/protected/traversing asset refusal. Python's ZIP reader confirms
five exact entries, CRCs and original bytes after source edits.

Database routing, transactional races, actual hub delivery and browser execution of previews
are source-inspected and compile-checked, not exercised against a running engine. No live data
or network peer was changed. During the prototype no unit-test suite was run.

PLAN C3 removes 3.x's multi-level delivery evidence. Manual reads therefore explicitly report
that waiting mail retains normal automatic delivery; they do not claim a provider receipt or
consume pending mail. A repeated tool call without either a known delivery_id or a preserved
provider tool-use ID cannot be recognized after total response loss. Earlier 4.0 presentations
whose source assets were never stored cannot have those missing assets reconstructed; the
snapshot contract applies to newly presented/replaced HTML. HTML downloads use ZIP's stored
method (no compression), with the same file bytes and relative layout.
