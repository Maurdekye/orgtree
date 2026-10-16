# Open scratch folders

The shared agent context menu offers **Open > Open scratch folder** for live and
archived agents in the native desktop. The canvas card, Agents List and desk/tab
navigation use the same menu definition. A browser, phone or older desktop shell
without the native capability has no entry.

The same agent Open submenu offers **Open team scratch folder** immediately
after personal scratch. It opens the team this agent leads, keyed by numeric
agent id, even if the agent has no reports (user 2026-10-16 10:16Z). Rename and
retirement preserve that identity. The switchboard's overview and focused
header menus offer a flat **Open shared scratch folder** entry. The same
button lives in **Org settings > Basic > Shared scratch folder**, with the
existing folder icon and settings row styling. It opens independently of Save.

## Team and org shared targets (2026-10-16)

All three entries reuse `desktop:open-agent-scratch-folder`, the native helper,
the authenticated local engine endpoint and `shell.openPath`. The bridge
advertises `scratchFolderScopes` before the renderer exposes the new actions;
an older personal-only shell still offers its original action. Only identity
and the enumerated `team`/`shared` scope cross IPC, never a renderer path.

The existing endpoint accepts `?scope=team` for a normal agent identity.
`domain::teams::workspace` supplies the same `_teams/<numeric id>` path used
by launch grants. Org shared uses the reserved non-agent `_shared` endpoint
identity with `?scope=shared`; no arbitrary agent is chosen for org actions.
The path comes from `Config::org_notes_dir`. Conflicting identities and unknown
scopes are refused. Scoped replies echo their scope, so an old engine ignoring
query parameters cannot make a personal response look like a team success.

Missing team/shared directories are created on demand. The engine checks the
configured org-scratch containment, resolves trusted data-root aliases, and
walks managed components individually. It rejects symlinks, Windows reparse
points and non-directories before proceeding; it never recursively creates
through an unchecked org/scratch/team ancestor. Filesystem I/O holds no database
transaction or client. The original personal path behavior below is unchanged.

Tests first: exact `a5f92af` on base `b3791bb` executed six renderer cases with
six genuine assertion failures, zero passes/skips/cancellations, exit1/3s.
Both switchboard surfaces and Settings really mounted; no fixture/setup errors.
Later assertions after each first failure were not executed.

Independent verification completed 2026-10-16 at exact `fb44599`:

| Check | Measured result |
| --- | --- |
| Final renderer | 6/6 pass, no skips/cancellations |
| Committed native runner | 3/3 pass |
| Windows managed path / team workspace units | 2/2 and 3/3 pass |
| Engine build / all-target check | Both exit0, zero warnings |
| Managed / existing personal synthetic proofs | 16/16 and 12/12, both JSONtrue |
| Three entry screenshots | All captured, JSONtrue; reviewer and author viewed every PNG |

The engine/native/unit/proof results were measured at `54800e2`; final
`fb44599` changes only test fixtures and capture runners. Production engine,
main/preload, renderer source and contracts were verified byte-identical.
The source engine SHA-256 is
`202f22665acb49892243ebc05ba8548136c0c178459b7ec4c1e814a564e5ed4d`.
The managed proof includes actual Windows junction/file refusal, unchanged
outside targets, numeric leaf-team creation, rename/archive, repeat resolution,
shared creation and authenticated organization-scoped identity checks. The
personal proof retains stored/imported paths and missing-folder no-create
behavior. Proof cleanup reported no remaining runs or stray processes.

Root typechecking had zero errors at reference `ca9da88` and product tip
`bb1b357`; their relevant UI source was compared against the original base and
final tip. Neighbor suites retain the same retire-all confirmation failure:
reference 30 pass/1 fail, tip 36 pass/1 fail. Strict renderer 29 and tests 830
diagnostics match actual `b3791bb` baseline with zero added/removed diagnostic
multiplicities. The final new test is included at baseline through read-only
filesystem callbacks and at tip, with exclude[] and zero diagnostics in that
file. Skills coverage is 8 pass/1 fail at both base/tip: the existing canvas
background/intensity label-home mismatch. The new Organization folder row has
its correct home. These suites are not wholly green.

Earlier failed receipts remain recorded: the native force-exit runner aborted
after three passing assertions; the original test helper failed compilation
and executed zero Rust tests; seven new strict fixture diagnostics were fixed;
the first visual run exited0 but reported JSONfalse after only one PNG. The
corrected capture keeps Electron alive between fresh windows, and its parent
requires successful JSON, all three entries and nonempty PNGs. Portable runners
read dependencies in place and write bundles into the assigned C scope.

Screenshots use synthetic production components; proofs use a disposable
database/fake CLI and inject the final native opener. No real OS file manager,
installed app, provider or device was exercised. The Unix-only link unit was
not executed on Windows. Local source integration does not establish installed
behavior or verification of the combined integration tip.

## Personal scratch (existing behavior)

The native sender gate binds the request to its organization window. IPC accepts
only organization and agent identity. Desktop main reads the path through an
authenticated, bounded request to its local engine's
`GET /api/orgs/{slug}/nodes/{nid}/scratch-folder` endpoint, without redirects.
The endpoint accepts existing, non-deleted agents and returns their stored
`scratch_dir`, falling back to the configured scratch root plus current agent
name when it is null. Stored imported/custom paths and paths retained after
rename remain authoritative. The metadata read neither lists contents nor
creates directories.

Desktop main resolves and verifies an existing absolute directory, then calls
Electron `shell.openPath`: File Explorer on Windows and the OS file manager on
macOS/Linux. A missing folder, file in place of a folder, lookup failure or native
opening error produces a toast. No folder is created; no renderer-supplied path,
file link or shell command is executed. Markdown file links retain reveal-only
behavior.

These choices were confirmed by the coordinator on 2026-10-11: existing directory
opening conventions, native-only availability, live/archived agents and refusal
without creation for a missing folder.

Verification: `tests/scratch-folder.test.mjs` exercises the native path against a
loopback fixture and real disposable filesystem, with an injected directory
opener. `renderer/tests/scratch-folder.test.tsx` checks menu/capability and error
handling. `tools/rig/proofs/scratch-folder.mjs` checks stored, renamed, custom,
archived, fallback, missing, deleted and unauthenticated engine lookups. The
injected opener does not prove an interactive File Explorer/Finder/Linux launch;
native visual acceptance remains for the running desktop build.

Measured on 2026-10-11: cargo check and debug engine build passed; two native
tests, one renderer capability/menu/toast check, and TypeScript checking passed.
The isolated rig passed all 12 checks, including real rename/retire operations,
the production native helper against the real authenticated endpoint, a file
replacing the folder, cross-organization lookup and unauthenticated refusal.
Its evidence records source engine, existing fake CLI and native-helper bundle
SHA-256 hashes. The run stopped and removed its disposable staging; cleanup
reported no remaining runs or stray processes. The final integration rebase
changed desktop imports and preserved both switchboard and agent actions; the
engine source tree remained identical to the checked/built/proved source.
