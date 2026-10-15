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
- Final source `3454e80` has eight Windows workspace cases and one additional
  Unix-only native leaf-symlink case, plus the native-startup case, including
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

Independent rig results on `3454e80` (2026-10-15): workspace 8, startup 3,
global-instruction 15, Muse hostline 1 and skills 8 unit cases all passed (35 total,
zero compiler warnings). The Unix-only leaf-symlink case was not executed on
Windows. Runtime checks passed: own-notes 10/10, AGY lane 27/27, composed global
instructions 14/14 and unchanged skills idle 3/3. The engine binary was built at
`ea7d5ac` with no warnings; `3454e80` changes only a test assertion, so its production
code is identical.

Retained controls: original overwrite/feedback tests failed 2/2, output-link
tests failed 2/2, and migration-link test failed 1/1 at their intended semantic
assertions. The behavior baseline passed its normal-launch control and failed
the nine feature checks, using the saved `b77512f` engine: AGY, startup and actor
source files are byte-identical between that source and the requested `72ea305`
baseline. The first candidate unit group at `ea7d5ac` passed workspace 8/8 but
startup had 2 passes and 1 failure: its uppercase `AGENTS.md` suffix assertion
could not match Windows-normalized lowercase keys. The one-line test correction
compares the exact normalized expected key and preserves all behavioral assertions.
The original failure remains in the logs; later groups were not executed in that
failed-fast attempt. These are synthetic scratch/fake-CLI results, not native
model obedience or provider-token budget measurements.

## Output path boundary (2026-10-15 source review)

Identity rule writes and stale-owned-part removal canonicalize the trusted parent
of scratch first, allowing system aliases such as macOS `/var` to `/private/var`.
They reject symlinks and Windows reparse points at scratch itself and below,
including `.agents`, `rules` and the part file. Output uses the anchored canonical
parent plus the unchanged scratch leaf; the scratch leaf is never canonicalized
away before validation. Validation occurs before directory creation or old-part reads,
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

Migration resolves the same trusted parent and validates scratch before inspecting AGENTS.md. A native leaf symlink is then skipped without error or rename; regular candidates and backup destinations retain full output validation. Windows junction controls remain separate.

The v4.3.0 macOS CI run 38786926928 exposed the previous all-ancestor guard:
five workspace cases failed because a trusted temporary-directory ancestor was a
link. The follow-up adds a cross-platform parent-alias regression (Unix symlink,
Windows junction): repeated workspace writes and legacy migration must succeed,
while a rules link inside the managed tree must still refuse writes and cleanup.
Existing root-link and `.agents`/`rules` negative controls remain. The author
cannot execute macOS locally; the revised suite requires platform CI/rig results.
