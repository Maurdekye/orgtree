# Antigravity identity and standing notes

The old adapter wrote its generated identity into the agent's scratch AGENTS.md.
That replaced standing memory, then `standing_notes` mirrored the generated text
back into the next identity. The adapter now keeps the same cwd and writes only
owned `.agents/rules/orgtree-identity-NNNN.md` files. AGENTS.md, GEMINI.md and their
`.agents/` counterparts are native workspace inputs. AGENTS.md is not also copied
into the generated identity. Non-native CLAUDE.md and granted-folder notes keep
their existing delivery behavior. Other harnesses are unchanged.

The identity rule parts are deterministic UTF-8 slices of at most 23,000 bytes,
plus fixed frontmatter. Joining their bodies in numbered order reproduces the
entire generated identity. Unchanged parts are not rewritten; surplus owned parts
are removed only when preparing a replacement process. An existing reserved rule
path without the exact ownership header refuses the launch rather than being
overwritten. Generated parts do not feed back into the startup-file digest.
Native note edits change that digest, so the next turn replaces the parked process
and resumes its conversation. This is prefix compatibility, not a cache-hit claim.

## Discovery evidence and limits

The [official CLI rules documentation](https://www.antigravity.google/docs/rules/)
specifies native AGENTS.md/GEMINI.md and immediate `.agents/rules/*.md` discovery.
Modular rules require valid YAML frontmatter; these use `trigger: always_on`.
Both native notes and always-on rules share a 24,000-byte per-file ceiling and a
20,000-token aggregate budget. Splitting prevents single-file truncation but does
not bypass the aggregate budget. Other global/project rules consume it too.

Installed agy 1.3.5 was inspected without executing a model call. Executable
SHA256: `4790560754318d0ced2358d13cbce9181dfc51d1964c3d95c9776e8eaf5cd3c4`.
Offline Go symbol/disassembly inspection found `Manager.getRules` calling
`markdownRuleCandidates`, `readGlobalRules`, `visitParentCustomizationFiles` and
`parseRuleFile`. This supports the documented path; it is not a live model-loading
receipt. No paid turn, login or real profile modification was performed.

The largest of 54 supplied read-only legacy snapshots was 56,918 bytes / 56,557
Unicode characters / 9,460 whitespace words. A rough English-prose character/4
estimate is 14,140 tokens, leaving 5,860 (29.3%); character/3 sensitivity gives
18,853, leaving 1,147 (5.7%). Neither is the native tokenizer. The unit regression
uses 56,918 bytes, checks complete bounded parts and absence of the old native
duplicate; it does not claim provider-token or global-budget verification.

## Legacy migration (coordinator ruling, 2026-10-15 12:28 UTC)

The measured snapshot classes were 47 exact generated envelopes, six structural
candidates with unrecognized endings, and one with clearly authored text outside
the envelope. Current canonical renders were unavailable. Exact-current-render
equality therefore had no proven coverage and would retain duplicated identities.

At process replacement, after stopping the old CLI, the engine checks the exact
generated opening sentence and a known closing section, without trimming bytes.
A match is renamed to a unique `AGENTS.generated-identity-<uuid>.bak`; the log records
source, backup, size and reason, never the body. Every byte is retained. The startup
plan is then recaptured after migration, so the saved fingerprint matches what the
new CLI sees. Nonmatching files and symlinks are left untouched and remain native.
No lost historical notes can be recovered by this fix.

**Accepted residual:** an edit inside a matching envelope moves into the backup
rather than remaining active. It can be restored manually. The six structural-only
and one clearly authored snapshots would not migrate; any stale identity in such
files continues to be loaded natively. Their bytes are never rewritten or mirrored
into the new generated identity. The snapshot corpus is private evidence, not a
repository fixture, and was deleted after the metadata-only classification receipt.

## Verification handoff

- Pre-fix tests committed first at `e0eb352`: `workspace_notes_tests` originally
  contained two cases, expected to fail on the overwrite/feedback path.
- Product tip adds five workspace cases total and one native-startup case, including
  recoverable migration, outside-envelope preservation, 56,918-byte parts, UTF-8,
  unchanged writes, shrink cleanup and reserved-name collision preservation.
- `node tools/rig/rig.mjs run tools/rig/proofs/agy-own-notes.mjs`: ten checks,
  synthetic scratch and fake AGY only. Includes the real idle timer, unchanged PID,
  a native-note edit, migration, backup bytes and nonmatching notes. Run against
  base `72ea305` and the composed candidate; inspect raw red results.
- Existing `agy-lane.mjs` is the adjacent regression. No fake CLI source change.
- Composition with global instruction sharing must use `Inputs::Agy { home, cwd }`,
  union its global native files with `agy_project(cwd)`, retain `Shared`, and retain
  shared-skills' combined digest at plan, timer and forecast.

Only syntax/diff checks were performed by the author; compiled and runtime results
belong to the independent rig receipt.

## Output path boundary (2026-10-15 source review)

Identity rule writes and stale-owned-part removal reject symlinks and Windows
reparse points at every existing ancestor, including scratch, `.agents`, `rules`
and the part file. Validation occurs before directory creation or old-part reads,
and is repeated before writes/removals. Two synthetic junction/symlink controls
cover `.agents` and `rules`, checking no external part is written or removed.
This boundary validation does not claim protection against a hostile concurrent
path swap. Native read manifests, the 47/54 envelope migration rule and the other
seven preserved files are unchanged. No live profile or native CLI probe was run.

Migration runs before rule writing, so it independently applies the same output
ancestor guard before reading legacy AGENTS.md and immediately before renaming
source to backup. A third negative case points scratch at an external envelope
and requires unchanged external bytes with no backup. The envelope predicate and
normal migration behavior are unchanged; native read discovery is not restricted.
