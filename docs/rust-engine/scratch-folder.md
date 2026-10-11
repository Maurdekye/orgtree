# Open an agent's scratch folder

The shared agent context menu offers **Open > Open scratch folder** for live and
archived agents in the native desktop. The canvas card, Agents List and desk/tab
navigation use the same menu definition. A browser, phone or older desktop shell
without the native capability has no entry.

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
